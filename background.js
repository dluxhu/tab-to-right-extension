// dLux Open New Tab To The Right or Below - Chrome Extension
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
// Two deep: opening a saved tab group focuses one of its own tabs, so by the time
// the group event arrives the "current tab" can already be a group member. The
// one before it is then the tab the user was actually on.
const lastActiveByWindow = new Map();
const prevActiveByWindow = new Map();

// Mirrored into session storage, because the maps alone don't survive the service
// worker being unloaded after ~30s idle — and opening a saved tab group is exactly
// the sort of event that wakes it, so on the path that needs an anchor most there
// would otherwise be nothing to anchor to. Undefined on a build without it, in
// which case tracking is simply in-memory again.
const ACTIVE_KEY = 'activeByWindow';
const sessionArea = chrome.storage.session;

let hydrated = false;
const queuedActivations = [];

function recordActivation(winId, tabId) {
  const current = lastActiveByWindow.get(winId);
  if (current !== undefined && current !== tabId) prevActiveByWindow.set(winId, current);
  lastActiveByWindow.set(winId, tabId);
}

function persistActive() {
  if (!hydrated) return; // never write over the saved pairs before reading them
  sessionArea?.set({
    [ACTIVE_KEY]: Object.fromEntries(
      [...lastActiveByWindow].map(([w, id]) => [w, [id, prevActiveByWindow.get(w)]])),
  }).catch(() => {});
}

// Activations arriving before the rehydrate are queued rather than applied, then
// replayed on top of it. Merging the two live would drop the shift into
// prevActiveByWindow for exactly the event this feature exists to survive: the
// group's own tab taking focus on a cold worker.
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  if (!hydrated) {
    queuedActivations.push([windowId, tabId]);
    return;
  }
  recordActivation(windowId, tabId);
  persistActive();
});

const activeReady = Promise.resolve()
  .then(() => sessionArea?.get(ACTIVE_KEY))
  .then(saved => {
    for (const [w, [current, previous]] of Object.entries(saved?.[ACTIVE_KEY] || {})) {
      const winId = Number(w);
      if (current !== undefined) lastActiveByWindow.set(winId, current);
      if (previous !== undefined) prevActiveByWindow.set(winId, previous);
    }
  })
  .catch(err => console.log('[dLux TabToRight] no saved active-tab history', err))
  // Independently of the above: fill in any window it knew nothing about.
  .then(() => chrome.tabs.query({ active: true }))
  .then(tabs => {
    for (const t of tabs) if (!lastActiveByWindow.has(t.windowId)) lastActiveByWindow.set(t.windowId, t.id);
  })
  .catch(err => console.log('[dLux TabToRight] could not read the active tabs', err))
  .then(() => {
    hydrated = true;
    for (const [winId, tabId] of queuedActivations) recordActivation(winId, tabId);
    queuedActivations.length = 0;
    persistActive();
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
// A cold-started service worker can get its first event before this resolves —
// opening a saved group is exactly the kind of thing that wakes it — so handlers
// await this instead of silently reading the defaults.
// The catch matters: every handler awaits this, so a rejection would disable the
// extension for the worker's lifetime instead of falling back to the defaults.
const settingsReady = chrome.storage.local.get(DEFAULTS)
  .then(s => { settings = s; })
  .catch(err => console.log('[dLux TabToRight] settings unreadable, using defaults', err));

// Everything a cold-started worker needs before it can judge anything.
const ready = Promise.all([settingsReady, activeReady]);

// The tab the user was on, out of the candidates given. The most recent
// activation, or the one before it when the most recent is itself excluded —
// which is what happens when a new tab or an opening group takes focus first.
// Only ever called after `ready`, so the history is complete.
const anchorIn = (winId, candidates) =>
  [lastActiveByWindow.get(winId), prevActiveByWindow.get(winId)]
    .map(id => candidates.find(t => t.id === id))
    .find(Boolean);
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

// When each tab was created, so a group can tell brand-new tabs from ones the
// user already had. A tab is "new" just long enough for a group to appear and
// finish filling; beyond that, grouping it is something the user did by hand.
const NEW_TAB_MS = GROUP_OPENING_MS + GROUP_FILL_MS;
const newTabAt = new Map();
const isNewTab = id => Date.now() - (newTabAt.get(id) ?? -Infinity) < NEW_TAB_MS;
function recentCreates(winId) {
  const now = Date.now();
  const times = (createTimes.get(winId) || []).filter(t => now - t < BURST_MS);
  createTimes.set(winId, times);
  return times;
}
chrome.windows.onRemoved.addListener(winId => {
  createTimes.delete(winId);
  lastActiveByWindow.delete(winId);
  prevActiveByWindow.delete(winId);
  persistActive();
  groupOpenedAt.delete(winId);
});

// A group appearing in a window is a far better signal that a saved tab group is
// opening than each tab's own groupId, which Chrome stamps a beat later and not
// always within our settle delay — waiting on that raced badly, and a two-tab
// group is under the burst threshold, so groups came apart at random. This still
// needs the event within the settle delay below, but that window is much wider
// than the one it replaced, and the per-tab groupId check remains as a backstop.
const groupOpenedAt = new Map(); // windowId -> { at, groupId } of the last group

// Is this new tab part of a group that is opening? Chrome doesn't promise an
// order between tabs.onCreated and tabGroups.onCreated, so either shape of the
// evidence counts: the tab is already stamped with a group, or it existed before
// the group did. A tab created *after* a group appeared and still ungrouped is
// just a new tab — Cmd+T straight after grouping some tabs by hand.
function groupOpening(winId, tab, tabCreatedAt) {
  const g = groupOpenedAt.get(winId);
  if (!g || Date.now() - g.at >= GROUP_OPENING_MS) return false;
  // Its own group, not merely some group: a link opened from a tab that happens
  // to sit in an unrelated group is still a link, and still gets restacked.
  // The grace after g.at covers a group's later members, which are necessarily
  // created after the group exists and may not be stamped yet. Deliberately the
  // short fill window, not the full opening one: a new tab a second after you
  // grouped some tabs by hand is a new tab, and should still be repositioned.
  return tab.groupId === g.groupId || tabCreatedAt <= g.at + GROUP_FILL_MS;
}

chrome.tabGroups.onCreated.addListener(async (group) => {
  const winId = group.windowId;
  groupOpenedAt.set(winId, { at: Date.now(), groupId: group.id });
  await ready;
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

  // The restore backstop the per-tab path has, because onStartup can lose the race
  // with the first restored tabs. Not the burst guard, though: a group opening is
  // itself a burst of creations, so that would refuse every group of three or more.
  // ponytail: leans on Chrome restoring group tabs lazily. A restored one-tab group
  // that isn't discarded rides on the hush alone.
  if (groupTabs.some(t => t.discarded)) {
    console.log('[dLux TabToRight] group skipped: discarded (session restore)');
    return;
  }

  // Only a group that arrived with brand-new tabs is a group *opening*. One the
  // user built out of tabs they already had belongs where they built it. Asked
  // here, once the group has filled, so it doesn't depend on event ordering.
  if (!groupTabs.some(t => isNewTab(t.id))) {
    console.log('[dLux TabToRight] group skipped: built from tabs that already existed');
    return;
  }

  // Chrome appends an opening group at the end of the strip. A group the user
  // just made out of tabs they already had sits mid-strip — leave that alone.
  if (Math.max(...groupTabs.map(t => t.index)) !== allTabs.length - 1) {
    console.log('[dLux TabToRight] group skipped: not at the end (grouped in place)');
    return;
  }

  const others = allTabs.filter(t => t.groupId !== group.id);
  // The tab the user was on: the current one, or the one before it when the group
  // has already taken focus. No lastAccessed fallback here — Chrome bumps it on
  // tab *creation*, so the group's own fresh tabs would outrank the real anchor.
  // Nothing to anchor to means leaving the group where Chrome put it.
  const ref = anchorIn(winId, others);
  if (!ref) {
    console.log('[dLux TabToRight] group skipped: no reference tab outside the group');
    return;
  }
  // Land after the whole of the reference's own group, never in the middle of it
  // (tabGroups.move refuses that), and never inside the pinned strip.
  const after = ref.groupId === -1 ? ref
    : allTabs.filter(t => t.groupId === ref.groupId).reduce((a, b) => (a.index > b.index ? a : b));
  const index = Math.max(after.index + 1, allTabs.filter(t => t.pinned).length);
  try {
    await chrome.tabGroups.move(group.id, { index });
    console.log('[dLux TabToRight] moved group', group.id, 'to', index, 'after', after.id);
  } catch (err) {
    console.log('[dLux TabToRight] group move failed', err?.message || err);
  }
});

chrome.tabs.onCreated.addListener(async (newTab) => {
  if (!newTab || typeof newTab.id !== 'number') return;

  const winId = newTab.windowId;
  const createdAt = Date.now();
  // Read now, before this tab's own onActivated lands. A second new tab opened
  // inside our settle delay would otherwise be the most recent activation, and
  // this one would anchor on it — both then sit at the end of the strip.
  const activeBefore = lastActiveByWindow.get(winId);
  recentCreates(winId).push(createdAt);
  for (const [id, at] of newTabAt) if (createdAt - at > NEW_TAB_MS) newTabAt.delete(id);
  newTabAt.set(newTab.id, createdAt);
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

  await ready;

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

  // A group is opening in this window, so this tab is one of its members — whether
  // or not Chrome has stamped its groupId yet. The group handler above decides
  // where the whole group goes; never move its tabs one at a time. Checked here,
  // after the query, to give the group event as long as possible to arrive.
  if (groupOpening(winId, tab, createdAt)) {
    console.log('[dLux TabToRight] skipped: a tab group is opening in this window');
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

  // Links sit next to the page they were opened from. Everything else goes beside
  // the tab the user was on — `others` excludes this new tab, so a tab that stole
  // focus resolves to the activation before it.
  let ref = !nearEnd && tab.openerTabId
    ? others.find(t => t.id === tab.openerTabId)
    : undefined;
  const viaOpener = !!ref;
  if (!ref && activeBefore !== undefined) ref = others.find(t => t.id === activeBefore);
  // Anything at least as new as this tab is a sibling of it, never its anchor:
  // that's the whole reason activeBefore is read early. Both fallbacks below
  // need the same exclusion — lastAccessed especially, since Chrome bumps it on
  // tab creation, so a sibling would sort to the very top.
  const older = others.filter(t => (newTabAt.get(t.id) ?? -Infinity) < createdAt);
  // Cold worker: nothing was tracked yet when this tab was created, so fall back
  // to the rehydrated history.
  let viaHistory = false;
  if (!ref) {
    ref = anchorIn(winId, older);
    viaHistory = !!ref;
  }
  if (!ref) {
    // Nothing tracked at all: the least-bad guess left.
    ref = [...older].sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
  }
  if (!ref) {
    console.log('[dLux TabToRight] skipped: nothing to anchor to');
    return;
  }
  console.log('[dLux TabToRight] reference', {
    id: ref.id, index: ref.index, groupId: ref.groupId,
    via: viaOpener ? 'opener' : ref.id === activeBefore ? 'active' : viaHistory ? 'history' : 'lastAccessed'
  });

  // Re-read the reference: it may itself have been repositioned since the query
  // above, in which case the index from that snapshot would move us nowhere.
  // Grouping is best-effort, so a failure there never undoes the move.
  const anchor = await chrome.tabs.get(ref.id).catch(() => ref);
  try {
    await chrome.tabs.move(tab.id, { index: anchor.index + 1 });
    console.log('[dLux TabToRight] moved tab', tab.id, 'after', anchor.id);
  } catch (err) {
    console.log('[dLux TabToRight] move failed', err?.message || err);
    return;
  }
  if (anchor.groupId !== -1) {
    chrome.tabs.group({ groupId: anchor.groupId, tabIds: [tab.id] }).catch(() => {});
  }
});
