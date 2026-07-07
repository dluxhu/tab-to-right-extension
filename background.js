// dLux Open New Tab To The Right - Chrome Extension
// Makes Cmd+T (and equivalent New Tab actions) open the new tab immediately to the right
// of the currently active tab.
//
// This also covers opening special pages such as Bookmarks Manager (chrome://bookmarks),
// History, Downloads, Settings, etc. from the menu or bookmarks bar.
//
// We deliberately ignore:
// - Real web pages: links opened in a new tab (Cmd/Ctrl/middle-click, "open in
//   new tab") and duplicates/restores of pages all load an http(s) URL and are
//   already placed sensibly by Chrome. (We can't use openerTabId to detect link
//   opens: modern Chrome/Brave set it on Cmd+T too.)
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

// Remember which tab is active in each window. When a new tab is created it
// *immediately* steals "active", so at onCreated time the previously-viewed
// tab is only knowable from having tracked it here.
//
// (We do NOT use tab.lastAccessed for this: Chrome bumps lastAccessed when a
// tab is *created*, not only when it becomes active, so a freshly-opened
// background tab would outrank the tab the user is actually looking at.)
// ponytail: in-memory map, reset on service-worker restart; the lastAccessed
// fallback below covers that gap until the next onActivated repopulates it.
const lastActiveByWindow = new Map();
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  lastActiveByWindow.set(windowId, tabId);
});

chrome.tabs.onCreated.addListener(async (newTab) => {
  if (!newTab || typeof newTab.id !== 'number') return;

  const winId = newTab.windowId;
  // Capture synchronously, before the new tab's own onActivated overwrites it.
  const prevActiveId = lastActiveByWindow.get(winId);
  const url = (newTab.pendingUrl || newTab.url || '');

  console.log('[dLux TabToRight] onCreated', {
    id: newTab.id,
    index: newTab.index,
    url,
    openerTabId: newTab.openerTabId,
    groupId: newTab.groupId,
    active: newTab.active
  });

  // Leave real web pages where Chrome puts them: a link opened in a new tab
  // (Ctrl/Cmd-click, "open in new tab"), a duplicated page, and a restored tab
  // all load an http(s) URL and are already positioned sensibly by Chrome.
  // A genuine "new tab" action (Cmd+T, the + button, or a chrome:// page opened
  // from the UI) shows the New Tab Page / an internal URL instead.
  //
  // We deliberately do NOT key off openerTabId: modern Chrome and Brave set it
  // even for Cmd+T, so it no longer distinguishes new tabs from link opens.
  // (That guard is what made every new tab get skipped and stranded at the end.)
  if (/^https?:\/\//i.test(url)) {
    console.log('[dLux TabToRight] skipped: real web page (link/duplicate/restore)', url);
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

  // Find the tab to insert after: the tab that was active before this new one
  // stole focus (tracked via onActivated). Exclude the new tab itself.
  const candidates = allTabs.filter(t => t.id !== newTab.id);
  if (candidates.length === 0) {
    console.log('[dLux TabToRight] no other tabs to insert after');
    return;
  }

  let ref = candidates.find(t => t.id === prevActiveId);
  if (!ref) {
    // Fallback (e.g. service worker just started and hasn't observed an
    // onActivated yet): most recently accessed other tab.
    candidates.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    ref = candidates[0];
    console.log('[dLux TabToRight] no tracked active tab, fell back to lastAccessed:', {id: ref.id, index: ref.index});
  } else {
    console.log('[dLux TabToRight] chosen reference = previously active tab:', {id: ref.id, index: ref.index, groupId: ref.groupId});
  }

  if (count <= 1) {
    console.log('[dLux TabToRight] only one tab in window');
    return;
  }

  console.log('[dLux TabToRight] repositioning tab', newTab.id, 'after', ref.id);
  doReposition(newTab, ref);
});
