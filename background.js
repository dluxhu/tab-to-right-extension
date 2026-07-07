// dLux Open New Tab To The Right - Chrome Extension
// Makes Cmd+T (and equivalent New Tab actions) open the new tab immediately to the
// right of the currently active tab. Also covers special pages opened from the UI
// (Bookmark Manager, History, Downloads, Settings, opening a bookmark, etc.).
//
// We decide by *position*: Chrome appends genuine "new tab" actions at the end of
// the strip, so we reposition tabs created near the end and leave the rest alone.
// That naturally ignores links opened from a page (Chrome inserts those next to
// their source — and openerTabId can't be used to detect them, since modern
// Chrome/Brave set it on Cmd+T too), duplicates, restores, and new windows.
//
// Tab groups need one extra step: opening a saved group / creating a new group
// assigns groupId a beat AFTER onCreated, so we wait a moment and re-read it.
// Grouped by then -> a group opening/creating: leave it (at the end, intact,
// beside not nested). Still ungrouped -> a real new tab: move it next to the
// current tab, joining the current tab's group if it has one (so Cmd+T inside a
// group stays in the group).

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

// Time to let Chrome finish assigning a new tab to a group before we act.
// ponytail: fixed delay tuned by eye; raise it if a group's first tab still gets
// pulled out (the "after settle" log shows whether it was still ungrouped).
const GROUP_SETTLE_MS = 150;

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
  let tab;
  try {
    tab = await chrome.tabs.get(newTab.id);
  } catch {
    console.log('[dLux TabToRight] tab gone before we could act', newTab.id);
    return;
  }
  console.log('[dLux TabToRight] after settle', { id: tab.id, index: tab.index, groupId: tab.groupId });

  // Grouped now => a saved group opening or a new group being created: leave it.
  if (tab.groupId !== -1) {
    console.log('[dLux TabToRight] skipped: in a group (group opened/created)');
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
  // Only act on tabs Chrome appended at (or right next to) the end of the strip.
  if (tab.index < allTabs.length - 2) {
    console.log('[dLux TabToRight] skipped: not near the end', { index: tab.index, last: allTabs.length - 1 });
    return;
  }

  // Insert after the tab that was active before this one stole focus. Fall back
  // to the most recently accessed other tab when we have no tracked active tab
  // (e.g. the service worker just started).
  const others = allTabs.filter(t => t.id !== tab.id);
  if (others.length === 0) return; // new window's only tab
  let ref = others.find(t => t.id === prevActiveId);
  if (!ref) {
    others.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    ref = others[0];
  }
  console.log('[dLux TabToRight] reference', {
    id: ref.id, index: ref.index, groupId: ref.groupId, fallback: ref.id !== prevActiveId
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
