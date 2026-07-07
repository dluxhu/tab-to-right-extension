# dLux Open New Tab To The Right

Chrome extension that makes **new tabs** (triggered by Cmd+T / Ctrl+T or the + button / menu) open immediately to the right of your current tab.

## What it affects
- Keyboard shortcut for new tab (Cmd+T / Ctrl+T)
- "New Tab" menu item / + button in the tab strip

## What it deliberately ignores
- Opening a link in a new tab (Cmd/Ctrl+click, context menu, etc.) — Chrome already does a good job here and these have an `openerTabId`.
- Duplicate Tab — Chrome places the duplicate right next to the original.
- Restoring tabs or tab groups (session restore, Cmd+Shift+T, saved groups, third-party session managers) — restored tabs carry their real URLs and/or are inserted at non-end positions, so they are left exactly where Chrome puts them. Groups stay together.
- Anything that already has a `groupId` at creation time.

## Installation (development / unpacked)

1. Clone or download this folder.
2. Open Chrome and go to `chrome://extensions`.
3. Enable **Developer mode** (top right toggle).
4. Click **Load unpacked**.
5. Select the folder containing the extension (e.g. `tab-to-right-extension`).

The extension has no icon or popup — it just works silently.

## How it works (briefly)

- Listens to `chrome.tabs.onCreated`.
- Skips anything with `openerTabId` (normal link opens).
- Skips tabs pre-assigned to a group.
- Only acts on tabs Chrome appended near the *end* of the strip (Cmd+T, Bookmark Manager / other chrome:// pages opened from UI or bookmarks bar, middle-click bookmarks, etc.).
- To find *which* tab to place it after, it picks the other tab in the window with the highest `lastAccessed` time (the one you were most recently viewing). This is reliable even after the new tab steals focus and across MV3 service worker restarts.
- No "is this an empty/newtab page" URL checks.
- Moves it to `ref.index + 1`.
- If the reference tab belongs to a group, the new one joins the same group.

The end-of-strip check protects duplicate tab and most restore scenarios.

## Notes

- Works in Incognito (spanning).
- No options / no tracking.
- If you also want a dedicated shortcut that *forces* a new tab to the right regardless, consider pairing with an extension like "New Tab Here".

## License

MIT or whatever you want. Do whatever.

## Development tips

1. Go to `chrome://extensions`
2. Find "dLux Open New Tab To The Right"
3. Click the **service worker** link (or "Inspect views: service worker") to open the console.
4. Reload the extension (the reload button on the extension card).
5. Watch the console while you press **Cmd+T**.

You should see lines starting with `[dLux TabToRight]`.

### Common things the logs will tell you
- `onCreated` + the `url` / `openerTabId` it saw
- `skipped: has openerTabId` → this was a link open, correctly ignored
- `skipped: not a fresh new tab page` → the URL check rejected it (rare now)
- `repositioning using current active ...` or `using previous tab`
- If nothing appears at all for a Cmd+T, the extension may not be waking up or an early return is happening.

### Test cases
- Multiple tabs, Cmd+T repeatedly → each new tab appears directly after the previous active one.
- Cmd/Ctrl+click a link → should open according to Chrome's normal rules (usually next to the link source), untouched by us.
- Right-click tab → Duplicate → untouched.
- Tab inside a group: Cmd+T should create the new tab right after it and keep it inside the group.
- Restart Chrome with groups → groups should be restored exactly as Chrome left them.

If after the update it still doesn't move, copy the console output from a Cmd+T and share it.

Enjoy linear tab creation!
