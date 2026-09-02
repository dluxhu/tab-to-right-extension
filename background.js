// dLux Open New Tab To The Right - Chrome Extension
// Cmd+T and other "new tab" actions (Chrome appends those at the end of the
// strip) open immediately to the right of the current tab. Optionally, link
// clicks do too — newest always immediately to the right of the source tab
// (Chrome's default puts the second link to the right of the first).
//
// Tabs Chrome creates in batches — session restore, opening a saved tab group,
// "open all bookmarks" — are left exactly where Chrome put them. So are pinned
// tabs. Opening a saved tab group moves the group as a whole, or not at all.

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

// Time to let a new tab's index and group membership settle before we act.
// ponytail: fixed delay tuned by eye; the group signals below no longer depend on
// it, so this is just about reading a stable index.
const GROUP_SETTLE_MS = 250;

// How long after a group appears its tabs are still arriving.
const GROUP_OPENING_MS = 1500;
// Time for a group to finish filling before we move it as a whole.
const GROUP_FILL_MS = 400;

// groupPlacement: 'end' leaves an opening tab group where Chrome puts it;
// 'right' moves the whole group next to the current tab.
const DEFAULTS = { stackLinks: true, groupPlacement: 'end' };
let settings = { ...DEFAULTS };
chrome.storage.local.get(DEFAULTS).then(s => { settings = s; });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  for (const [k, { newValue }] of Object.entries(changes)) settings[k] = newValue;
});

// No popup: clicking the toolbar icon opens the options.
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

// Don't touch tabs Chrome is restoring after a relaunch. The settle delay below
// also gives onStartup time to fire before the first restored tab is considered.
let hushUntil = 0;
chrome.runtime.onStartup.addListener(() => {
  hushUntil = Date.now() + 8000;
  console.log('[dLux TabToRight] startup hush');
});

// A person opens one tab at a time; Chrome opens many at once (session restore,
// a saved group, "open all bookmarks"). Timestamp every creation per window and
// leave a whole burst wherever Chrome put it — this is the backstop for when the
// onStartup hush above loses the race with the first restored tabs.
// ponytail: 3-in-700ms tuned by eye; a false positive only costs one tab its
// repositioning, so err on the side of not touching things.
const BURST_MS = 700;
const BURST_MIN = 3;
const createTimes = new Map();
function recentCreates(winId) {
  const now = Date.now();
  const times = (createTimes.get(winId) || []).filter(t => now - t < BURST_MS);
  createTimes.set(winId, times);
  return times;
}
chrome.windows.onRemoved.addListener(winId => {
  createTimes.delete(winId);
  lastActiveByWindow.delete(winId);
  groupOpenedAt.delete(winId);
});

// A group appearing in a window is the reliable signal that a saved tab group is
// opening. Chrome stamps each tab's own groupId a beat later and not always
// within our settle delay — waiting on that raced, and a two-tab group is under
// the burst threshold, so groups came apart at random. This event doesn't race:
// any tab created in the window right after it belongs to the group.
const groupOpenedAt = new Map();
const groupOpening = winId => Date.now() - (groupOpenedAt.get(winId) || 0) < GROUP_OPENING_MS;

chrome.tabGroups.onCreated.addListener(async (group) => {
  const winId = group.windowId;
  groupOpenedAt.set(winId, Date.now());
  // Captured before the group's tabs steal focus.
  const prevActiveId = lastActiveByWindow.get(winId);
  console.log('[dLux TabToRight] group created', { id: group.id, winId, placement: settings.groupPlacement });
  if (settings.groupPlacement !== 'right') return;

  await new Promise(r => setTimeout(r, GROUP_FILL_MS));
  if (Date.now() < hushUntil) {
    console.log('[dLux TabToRight] group skipped: startup restore');
    return;
  }

  let allTabs;
  try {
    allTabs = await chrome.tabs.query({ windowId: winId });
  } catch (e) {
    console.log('[dLux TabToRight] group query failed', e);
    return;
  }
  const groupTabs = allTabs.filter(t => t.groupId === group.id);
  if (groupTabs.length === 0) return; // gone again already

  // Chrome appends an opening group at the end of the strip. A group the user
  // just made out of tabs they already had sits mid-strip — leave that alone.
  if (Math.max(...groupTabs.map(t => t.index)) !== allTabs.length - 1) {
    console.log('[dLux TabToRight] group skipped: not at the end (grouped in place)');
    return;
  }

  const ref = allTabs.find(t => t.id === prevActiveId && t.groupId !== group.id);
  if (!ref) {
    console.log('[dLux TabToRight] group skipped: no reference tab');
    return;
  }
  // A group can't start inside the pinned strip.
  const index = Math.max(ref.index + 1, allTabs.filter(t => t.pinned).length);
  try {
    await chrome.tabGroups.move(group.id, { index });
    console.log('[dLux TabToRight] moved group', group.id, 'to', index, 'after', ref.id);
  } catch (err) {
    console.log('[dLux TabToRight] group move failed', err?.message || err);
  }
});

chrome.tabs.onCreated.addListener(async (newTab) => {
  if (!newTab || typeof newTab.id !== 'number') return;

  const winId = newTab.windowId;
  // Capture before the new tab's own onActivated overwrites it.
  const prevActiveId = lastActiveByWindow.get(winId);
  recentCreates(winId).push(Date.now());
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

  // A group is opening in this window, so this tab is one of its members —
  // whether or not Chrome has stamped its groupId yet. The group handler above
  // decides where the whole group goes; never move its tabs one at a time.
  if (groupOpening(winId)) {
    console.log('[dLux TabToRight] skipped: a tab group is opening in this window');
    return;
  }

  // Checked after the settle so every tab of a burst sees the others' timestamps.
  if (recentCreates(winId).length >= BURST_MIN) {
    console.log('[dLux TabToRight] skipped: batch creation (restore / group / open-all)');
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

  // The pinned strip is the user's own layout; never reshuffle it.
  if (tab.pinned) {
    console.log('[dLux TabToRight] skipped: pinned');
    return;
  }

  // Backstop for the group signal above: grouped with no opener => Chrome grouped
  // it itself. A link clicked inside a group also lands grouped, but carries
  // openerTabId — that one we may still restack.
  if (tab.groupId !== -1 && !tab.openerTabId) {
    console.log('[dLux TabToRight] skipped: grouped by Chrome (group opened/created)');
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
