// dLux Open New Tab To The Right - Chrome Extension
// Cmd+T and other "new tab" actions (Chrome appends those at the end of the
// strip) open immediately to the right of the current tab. Optionally, link
// clicks do too — newest always immediately to the right of the source tab
// (Chrome's default puts the second link to the right of the first).
//
// Session restore is ignored: onStartup starts a hush that extends while tabs
// keep arriving, and discarded tabs (lazy-restored) are never moved.

// Track the active tab per window: a new tab immediately steals "active", so the
// previously-viewed tab is only knowable from having tracked it here. (We can't
// use tab.lastAccessed for this — Chrome bumps it on tab *creation*, not only on
// activation, so a freshly-opened background tab would outrank the current tab.)
// ponytail: in-memory, reset on service-worker restart; the lastAccessed fallback
// below covers that gap until the next onActivated repopulates it.
const lastActiveByWindow = new Map();
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  lastActiveByWindow.set(windowId, tabId);
});
chrome.tabs.query({ active: true }).then(tabs => {
  for (const t of tabs) lastActiveByWindow.set(t.windowId, t.id);
});

// Time to let Chrome finish assigning a new tab to a group before we act.
// ponytail: fixed delay tuned by eye; raise it if a group's first tab still gets
// pulled out (the "after settle" log shows whether it was still ungrouped).
const GROUP_SETTLE_MS = 150;

const DEFAULTS = { stackLinks: true };
let settings = { ...DEFAULTS };
chrome.storage.local.get(DEFAULTS).then(s => { settings = s; });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.stackLinks) return;
  settings.stackLinks = changes.stackLinks.newValue;
});

// Don't touch tabs Chrome is restoring after a relaunch. The 150ms settle below
// also gives onStartup time to fire before the first restored tab is considered.
let hushUntil = 0;
chrome.runtime.onStartup.addListener(() => {
  hushUntil = Date.now() + 8000;
  console.log('[dLux TabToRight] startup hush');
});

chrome.tabs.onCreated.addListener(async (newTab) => {
  if (!newTab || typeof newTab.id !== 'number') return;

  const winId = newTab.windowId;
  // Capture before the new tab's own onActivated overwrites it.
  const prevActiveId = lastActiveByWindow.get(winId);
  console.log('[dLux TabToRight] onCreated', {
    id: newTab.id, index: newTab.index, url: newTab.pendingUrl || newTab.url || '',
    openerTabId: newTab.openerTabId, groupId: newTab.groupId, active: newTab.active
  });

  // Let group membership settle, then re-read (index and groupId may both change
  // as sibling group tabs get created and grouped).
  await new Promise(r => setTimeout(r, GROUP_SETTLE_MS));

  if (Date.now() < hushUntil) {
    hushUntil = Date.now() + 2000;
    console.log('[dLux TabToRight] skipped: startup restore', newTab.id);
    return;
  }

  let tab;
  try {
    tab = await chrome.tabs.get(newTab.id);
  } catch {
    console.log('[dLux TabToRight] tab gone before we could act', newTab.id);
    return;
  }
  console.log('[dLux TabToRight] after settle', { id: tab.id, index: tab.index, groupId: tab.groupId, discarded: tab.discarded });

  // Lazy-restored session tabs. Never a live Cmd+T / link click.
  if (tab.discarded) {
    console.log('[dLux TabToRight] skipped: discarded (session restore)');
    return;
  }

  let allTabs;
  try {
    allTabs = await chrome.tabs.query({ windowId: winId });
  } catch (e) {
    console.log('[dLux TabToRight] query failed', e);
    return;
  }

  // Tab indices are contiguous (0..n-1), so the last index is allTabs.length - 1.
  // Chrome appends genuine "new tab" actions at the end; link clicks land next
  // to their source, mid-strip.
  const nearEnd = tab.index >= allTabs.length - 2;

  // Grouped + at the end => a saved group opening or a new group: leave it.
  if (tab.groupId !== -1 && nearEnd) {
    console.log('[dLux TabToRight] skipped: in a group (group opened/created)');
    return;
  }

  // Mid-strip: Chrome already placed it (link, duplicate). Restack only if opted in.
  if (!nearEnd && !settings.stackLinks) {
    console.log('[dLux TabToRight] skipped: not near the end', { index: tab.index, last: allTabs.length - 1 });
    return;
  }

  const others = allTabs.filter(t => t.id !== tab.id);
  if (others.length === 0) return; // new window's only tab

  // Links sit next to the page they were opened from. Cmd+T uses the previous
  // active tab. lastAccessed is only a service-worker cold-start fallback.
  let ref = !nearEnd && tab.openerTabId
    ? others.find(t => t.id === tab.openerTabId)
    : undefined;
  if (!ref) ref = others.find(t => t.id === prevActiveId);
  if (!ref) {
    others.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    ref = others[0];
  }
  console.log('[dLux TabToRight] reference', {
    id: ref.id, index: ref.index, groupId: ref.groupId,
    via: ref.id === tab.openerTabId ? 'opener' : ref.id === prevActiveId ? 'active' : 'lastAccessed'
  });

  // Move it just right of the reference; grouping is best-effort so a failure
  // there never undoes the move.
  try {
    await chrome.tabs.move(tab.id, { index: ref.index + 1 });
    console.log('[dLux TabToRight] moved tab', tab.id, 'after', ref.id);
  } catch (err) {
    console.log('[dLux TabToRight] move failed', err?.message || err);
    return;
  }
  if (ref.groupId !== -1) {
    chrome.tabs.group({ groupId: ref.groupId, tabIds: [tab.id] }).catch(() => {});
  }
});
