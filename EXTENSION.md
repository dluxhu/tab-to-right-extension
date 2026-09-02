# Chrome Web Store listing

Source of truth for the store description. Update it alongside
[CHANGELOG.md](CHANGELOG.md) whenever a release changes user-facing behaviour,
then paste the text below into the listing.

---

Open new tabs where you're working — not at the far end of a long tab strip.

dLux Open New Tab To The Right quietly repositions tabs created with Cmd+T / Ctrl+T, the + button, or the New Tab menu so they appear immediately to the right of the tab you were just using.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WHAT IT DOES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

• Places Cmd+T / Ctrl+T next to your current tab
• Works with the tab strip + button and New Tab menu
• Also covers common UI new tabs (e.g. Bookmark Manager, History, and similar pages opened from Chrome’s UI)
• Keeps every link you open in a new tab immediately to the right of the tab you clicked from, so the newest one is always the nearest. Chrome normally puts the second link after the first, pushing it further away each time. Optional — on by default.
• Opens saved tab groups either at the end of the tab strip or next to your current tab, whichever you prefer. The group moves as a whole and stays a group.
• If your current tab is in a group, the new tab joins that group
• Works in Incognito (spanning)
• Two optional settings, sensible defaults — install and go

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WHAT IT LEAVES ALONE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Chrome already handles many cases well. This extension does not interfere with:

• Duplicate Tab
• Session restore, Cmd+Shift+T, and restored tab groups
• Opening all bookmarks in a folder at once
• Pinned tabs
• Tabs you group yourself out of tabs you already had

Saved tab groups open at the end of the strip by default, exactly as Chrome does it. If you'd rather have them next to your current tab, that's a setting.

Your existing tab order and groups stay intact.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PRIVACY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

• Uses only the "tabs", "tabGroups" and "storage" permissions
• Your settings are stored locally on your own device — never synced, never sent anywhere
• No tracking, analytics, or ads
• No data collection
• No remote code or network requests
• No account required

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PERMISSIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

tabs — Required to see when a new tab is created and move it next to your previous tab.

tabGroups — Required to notice a tab group opening and to move it in one piece instead of tab by tab.

storage — Stores your two preferences locally.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
HOW TO USE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. Install the extension
2. Press Cmd+T (Mac) or Ctrl+T (Windows/Linux), or click +
3. The new tab opens beside the tab you were on

That’s it — the defaults suit most people.

To change anything, click the extension's toolbar icon (pin it from the puzzle-piece menu if you don't see it). You can also reach the settings from chrome://extensions → Details → Extension options.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SOURCE CODE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Free and open source. Read the code, file an issue, or build it yourself:

https://github.com/dluxhu/tab-to-right-extension

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FEEDBACK
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

If a new tab lands in the wrong place, note what you did (keyboard, menu, group, restore, etc.) and leave a review or support message so it can be improved.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CHANGES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## 1.3.0 — 2026-09-02

New
- Option: choose whether a saved tab group opens at the end of the tab strip
  (Chrome's default) or next to your current tab. Either way the group moves as
  a whole and stays a group.
- Clicking the toolbar icon opens the options.

Fixed
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
