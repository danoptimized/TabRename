# TabRename

A Chrome MV3 extension that permanently renames tabs by URL. Custom titles
persist across page loads and re-apply automatically when a site rewrites its
own title (unread counts, video titles, etc.).

## Install (load unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this `TabRename` folder.

## Use

Right-click a tab and choose **Rename this tab…**, or click the TabRename icon
in the toolbar. The popup prefills that tab's URL and title. Pick a scope and
click **Rename tab**:

- **This tab only** — renames just this tab. It survives reloads and the tab's
  own title rewrites, follows the tab if it's discarded and restored, and is
  cleaned up when the tab closes. It applies only while the tab stays on the
  URL it was renamed on, and it disappears on browser restart (tab IDs don't
  survive restarts).
- **All matching URLs** — renames every page whose URL matches the pattern,
  now and in the future. Patterns use `*` as a wildcard:

| Pattern | Matches |
| --- | --- |
| `https://example.com/report/123` | Exactly that URL |
| `https://mail.google.com/mail/*` | Anything under Gmail's mail view |
| `https://example.com/*` | Anything on example.com |

Rules live in `chrome.storage.sync` (URL rules) and `chrome.storage.session`
(tab rules), so URL rules sync across signed-in Chrome instances while tab
rules stay local to this browser session. Rules can be toggled, edited, or
deleted from the popup; opening the popup on a page that already has a rule
opens that rule for editing (a tab-specific rule wins if both exist).

## Files

- `manifest.json` — MV3 manifest; injects `content.js` into every page at `document_start`.
- `content.js` — matches the page URL against your rules, sets `document.title`, and keeps re-applying it via a `MutationObserver`.
- `background.js` — service worker; resolves tab-specific rules for content scripts (only it knows tab IDs), cleans them up when tabs close, and owns the right-click tab menu item.
- `popup.html` / `popup.js` — rule management UI.

## Limits

- Chrome's own pages (`chrome://`, Web Store) can't be injected, so they can't be renamed.
- The mapping is by URL, not by individual tab: two tabs on the same URL get the same custom name.
- `file://` pages need "Allow access to file URLs" enabled for the extension on `chrome://extensions`.
- A tab that was already open when Chrome (or the extension) loaded may miss the rename until you reload it once; every later load renames automatically.
