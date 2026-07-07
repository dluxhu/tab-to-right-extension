// dLux Open New Tab To The Right - Chrome Extension
// Makes Cmd+T (and equivalent New Tab actions) open the new tab immediately to the right
// of the currently active tab.
//
// This also covers opening special pages such as Bookmarks Manager (chrome://bookmarks),
// History, Downloads, Settings, etc. from the menu or bookmarks bar.
//
// We deliberately ignore:
// - Tabs with openerTabId (Cmd/Ctrl/ middle-click links from pages, most "open in new tab" actions from content)
// - Duplicates (Chrome inserts them locally next to the source, not at the global end)
// - Tabs that already have a groupId at creation time
// - Bulk restores / session restores (they are created at historical indices, not appended at the end)
// - New windows (single-tab case)

function doReposition(newTab, referenceTab) {
  if (!referenceTab || referenceTab.id === newTab.id) return;

  const targetIndex = referenceTab.index + 1;

  chrome.tabs.move(newTab.id, { index: targetIndex })
    .then(() => {
      // Keep the new tab inside the same group if the reference was grouped.
      const g = referenceTab.groupId;
      if (typeof g === 'number' && g !== -1) {
        chrome.tabs.group({ groupId: g, tabIds: [newTab.id] }).catch(() => {});
      }
      console.log('[dLux TabToRight] moved tab', newTab.id, 'to index', targetIndex);
    })
    .catch((err) => {
      console.log('[dLux TabToRight] move failed', err?.message || err);
    });
}

chrome.tabs.onCreated.addListener(async (newTab) => {
  if (!newTab || typeof newTab.id !== 'number') return;

  const winId = newTab.windowId;
  const url = (newTab.pendingUrl || newTab.url || '');

  console.log('[dLux TabToRight] onCreated', {
    id: newTab.id,
    index: newTab.index,
    url,
    openerTabId: newTab.openerTabId,
    groupId: newTab.groupId,
    active: newTab.active
  });

  // Ignore anything opened from another page (links, ctrl/cmd-click, etc.)
  if (newTab.openerTabId != null) {
    console.log('[dLux TabToRight] skipped: has openerTabId');
    return;
  }

  // Ignore if Chrome already put it in a group at creation (protects some group restores)
  if (typeof newTab.groupId === 'number' && newTab.groupId !== -1) {
    console.log('[dLux TabToRight] skipped: already has groupId at creation');
    return;
  }

  // Query current tabs in the window.
  let allTabs;
  try {
    allTabs = await chrome.tabs.query({ windowId: winId });
  } catch (e) {
    console.log('[dLux TabToRight] query failed', e);
    return;
  }

  const count = allTabs.length;
  const maxIndex = allTabs.reduce((max, t) => Math.max(max, t.index || 0), 0);

  // Chrome creates "new tab" actions (Cmd+T, Bookmark Manager from bar, etc.)
  // by appending them at (or near) the *end* of the tab strip (high index).
  // Duplicates and restores insert at other (usually lower) positions.
  const createdNearEnd = newTab.index >= maxIndex - 1;

  if (!createdNearEnd) {
    console.log('[dLux TabToRight] skipped: not created near the end of the strip', {index: newTab.index, maxIndex, count});
    return;
  }

  // Robust way to find the tab to insert after:
  // Exclude the newly created tab itself, then pick the one with the most recent lastAccessed time.
  // This is the tab the user was most recently looking at.
  // This works reliably even when the new tab has already been activated, and across service worker restarts.
  const candidates = allTabs.filter(t => t.id !== newTab.id);
  if (candidates.length === 0) {
    console.log('[dLux TabToRight] no other tabs to insert after');
    return;
  }

  candidates.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  const ref = candidates[0];

  console.log('[dLux TabToRight] chosen reference tab by lastAccessed:', {id: ref.id, index: ref.index, groupId: ref.groupId, lastAccessed: ref.lastAccessed});

  if (count <= 1) {
    console.log('[dLux TabToRight] only one tab in window');
    return;
  }

  console.log('[dLux TabToRight] repositioning tab', newTab.id, 'after', ref.id);
  doReposition(newTab, ref);
});
