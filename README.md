# dLux Open New Tab To The Right or Below

Chrome extension that opens new tabs next to the tab you're working in, instead
of at the far end of the strip. "Next to" means to the right in Chrome's normal
tab strip and below in the vertical one — the extension works on tab positions,
which are the same either way, so it needs no special handling for vertical
tabs. There is a test for it.

## What it does

- **New tab** (Cmd+T / Ctrl+T, the + button, the New Tab menu item) opens
  immediately to the right of your current tab.
- Also covers pages Chrome opens from its own UI: Bookmark Manager, History,
  Downloads, Settings, and bookmarks opened in a new tab.
- A new tab opened while you're inside a tab group joins that group.
- **Links** opened in a new tab stay immediately to the right of the tab you
  clicked from, so the newest is always the nearest. Chrome's default puts the
  second link after the first, pushing each new one further away. On by default,
  switch it off in the options.
- **Saved tab groups** open at the end of the strip (Chrome's default) or next
  to your current tab — your choice in the options. Either way the group moves
  as a whole and stays a group. Opened while you're inside another group, it
  lands after the whole of that group rather than nested inside it.

## What it leaves alone

- Duplicate Tab.
- Session restore and Cmd+Shift+T.
- Opening all bookmarks in a folder at once.
- Pinned tabs.
- Tabs you group yourself out of tabs you already had.

## Options

Click the extension's toolbar icon, or go to `chrome://extensions` → Details →
Extension options.

## Installation (development / unpacked)

1. Clone or download this folder.
2. Open Chrome and go to `chrome://extensions`.
3. Enable **Developer mode** (top right toggle).
4. Click **Load unpacked** and select this folder.

## How it works

Everything hangs off `chrome.tabs.onCreated`. After a short settle delay (a new
tab's index and group membership are both still moving when the event fires) the
tab is repositioned next to a reference tab — the tab that was active before the
new one stole focus, or for a link, the tab it was opened from.

Most of the code is about *not* acting. Chrome creates tabs in batches, and a
batch must be left exactly where Chrome put it or the layout comes apart:

- **A tab group is opening in this window.** `chrome.tabGroups.onCreated` is the
  signal, not each tab's own `groupId` — Chrome stamps that a beat later and not
  always within the settle delay, which used to tear groups apart at random. The
  group event still has to arrive within that delay, but its window is far wider
  than the one it replaced, and the per-tab `groupId` check stays as a backstop.
  A group only counts as *opening* if brand-new tabs arrived with it: a group
  must contain a tab, so a saved group's tabs always exist first, while a group
  you build out of tabs you already had brings none. The group handler then moves
  the group as a whole, or leaves it alone.
- **A burst of creations.** Three or more in one window inside 700ms is Chrome,
  not a person: session restore, open-all-bookmarks.
- **Session restore.** `onStartup` opens a hush that extends while tabs keep
  arriving; lazy-restored tabs are discarded and skipped outright.
- **Pinned tabs**, and tabs Chrome grouped itself.

The active tab is tracked via `chrome.tabs.onActivated`, because a new tab steals
focus before we can look. `tab.lastAccessed` can't stand in for it — Chrome bumps
that on tab *creation* too, so a background tab opened a second ago outranks the
one you're reading.

Two activations are kept per window, not one: opening a saved tab group focuses
one of the group's own tabs, so by the time the group event arrives the "current
tab" is often a member of the group being placed, and the anchor is the one
before it. The pair is mirrored into `chrome.storage.session`, since the service
worker is unloaded after ~30s idle and opening a saved group is exactly what
wakes it — without that, the path that most needs an anchor would never have one.

`test.mjs` does not cover the worker being unloaded and rehydrating: killing the
service worker also takes away the only context the harness can create tab groups
from. That path is reasoned, not measured.

## Tests

```
node test.mjs
```

Launches Chrome for Testing with the extension loaded, drives it over CDP, and
uses the extension's own service worker as the oracle. Set `CHROME` to point at
a different build.

```
VERTICAL=1 node test.mjs
```

Adds a run against the vertical tab strip. Headful, so windows will open and
close: headless Chrome draws no browser UI, so the strip can't switch there.

## Notes

- Works in Incognito (spanning).
- Works with the vertical tab strip (`chrome://flags` → Vertical tabs). Covered
  by `VERTICAL=1 node test.mjs`, which has to run headful.
- Permissions: `tabs`, `tabGroups`, `storage`. No network access, no data
  collection; the two settings live in `chrome.storage.local`.
