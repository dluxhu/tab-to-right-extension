# Changelog

## 1.3.0 — 2026-09-02

New
- Renamed to "dLux Open New Tab To The Right or Below": in the vertical tab
  strip, next to your current tab means below it. Tab positions are the same in
  both strips, so nothing needed adapting, and the vertical strip now has a test.
- Option: choose whether a saved tab group opens at the end of the tab strip
  (Chrome's default) or next to your current tab. Either way the group moves as
  a whole and stays a group.
- Clicking the toolbar icon opens the options.

Fixed
- With "next to my current tab" selected, a group you built yourself out of tabs
  you already had was treated as a group opening and pulled over to your current
  tab. It now stays where you built it.
- Opening a saved tab group could still pull tabs out of it. The previous fix
  waited a fixed moment for Chrome to mark each tab as grouped, which it does not
  always do in time — so a group came apart or stayed intact at random. Groups
  are now recognised when the group itself appears, which doesn't race.

## 1.2.0 — 2026-09-01

Fixed
- Opening a saved tab group no longer scatters its tabs across the strip.
- Restoring a session at startup no longer reorders your tabs.
- Pinned tabs are left where they are.

## 1.1.0 — 2026-08-15

New
- Option: keep every link you open immediately to the right of the tab you
  clicked from. Chrome normally puts the second link after the first, so the
  newest one drifts away. Toggle it in the extension's options.
- Restored sessions are left alone at startup.

## 1.0.0 — 2026-07-07

First release.
- New tabs (Cmd+T / Ctrl+T, the + button, the New Tab menu item) open
  immediately to the right of your current tab instead of at the far end.
- Also covers pages opened from the browser UI: Bookmark Manager, History,
  Downloads, Settings, and bookmarks opened in a new tab.
- A new tab opened from inside a tab group joins that group.
- Links, duplicated tabs, restored tabs, and tab groups are left where Chrome
  puts them.
