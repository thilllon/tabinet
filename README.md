<p align="center">
  <a href="https://chromewebstore.google.com/detail/bmbpmnfhfbdjdjpblimidmbohgccmjdg">
    <img src="assets/promo-marquee-1400x560.png" alt="Tabinet: one-click tab sorting and grouping for Chrome" width="100%" />
  </a>
</p>

<h1 align="center">Tabinet</h1>

<p align="center">
  <strong>One click. Every tab sorted, grouped, and de-duplicated, plus sessions you can save and restore, and timestamped notes on YouTube videos.</strong><br />
  No popup, no tracking, and no data leaves your browser unless you turn on the optional, end-to-end encrypted sync.
</p>

<p align="center">
  <a href="https://chromewebstore.google.com/detail/bmbpmnfhfbdjdjpblimidmbohgccmjdg"><img src="https://img.shields.io/chrome-web-store/v/bmbpmnfhfbdjdjpblimidmbohgccmjdg?label=Chrome%20Web%20Store&logo=googlechrome&logoColor=white" alt="Chrome Web Store" /></a>
  <a href="https://chromewebstore.google.com/detail/bmbpmnfhfbdjdjpblimidmbohgccmjdg"><img src="https://img.shields.io/chrome-web-store/users/bmbpmnfhfbdjdjpblimidmbohgccmjdg?label=users&logo=googlechrome&logoColor=white" alt="Users" /></a>
  <a href="https://chromewebstore.google.com/detail/bmbpmnfhfbdjdjpblimidmbohgccmjdg"><img src="https://img.shields.io/chrome-web-store/rating/bmbpmnfhfbdjdjpblimidmbohgccmjdg?label=rating&logo=googlechrome&logoColor=white" alt="Rating" /></a>
  <a href="https://github.com/thilllon/tabinet/releases"><img src="https://img.shields.io/github/v/release/thilllon/tabinet?logo=github" alt="GitHub release" /></a>
  <a href="https://github.com/thilllon/tabinet/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/thilllon/tabinet/ci.yml?branch=main&label=CI&logo=githubactions&logoColor=white" alt="CI" /></a>
</p>

<p align="center">
  <a href="https://chromewebstore.google.com/detail/bmbpmnfhfbdjdjpblimidmbohgccmjdg"><strong>➜ Install from the Chrome Web Store</strong></a>
  &nbsp;·&nbsp;
  <a href="https://thilllon.github.io/tabinet/"><strong>Website</strong></a>
</p>

## See it in action

Pin the icon, click it, and you're done. Every tab in the window is sorted and grouped by site:

<p align="center">
  <img src="assets/demo.gif" alt="Demo: one click sorts and groups all open tabs" width="800" />
</p>

<table>
  <tr>
    <th width="50%">Before</th>
    <th width="50%">After</th>
  </tr>
  <tr>
    <td><img src="assets/before-sort.png" alt="Before: tabs in random order" /></td>
    <td><img src="assets/after-sort.png" alt="After: tabs sorted and grouped by domain" /></td>
  </tr>
</table>

## Features

|                               |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **▸ One-click sorting**       | Click the toolbar icon. No menus, no dialogs: the current window is organized instantly.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **▸ Three sort modes**        | By URL, by title, or custom grouping that keeps sites in the order you first opened them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **▸ Smart grouping**          | Group by full hostname (`mail.google.com` ≠ `drive.google.com`) or by domain (all of Google together, `.co.uk`-style TLDs handled).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **▸ Native tab groups**       | Existing Chrome tab groups are sorted by name (prefix with `1-`, `2-` to pin an order) and tidied inside.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **▸ Duplicate detection**     | Leave duplicates alone, close all but one, or collect them into a labeled group to review first.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **▸ Gather all windows**      | Right-click the icon → **Assemble!** (or a keyboard shortcut, or the **Assemble!** button on the Open tabs screen) pulls every other window's tabs into the one you are using. Tabs are moved, never reopened, so pinned tabs, groups, history and typed text stay as they were, and your current tab stays in front.                                                                                                                                                                                                                                                                                                                                                                                    |
| **▸ Pause YouTube**           | Right-click the icon → **Pause all YouTube videos** (or its keyboard shortcut: Alt+Shift+P on a new install, Option+Shift+P on a Mac; set or change it at `chrome://extensions/shortcuts`) pauses the video in every YouTube tab of every window, each where it was. Running it again resumes nothing. The first time, Settings opens at its YouTube section to ask you to allow access to YouTube; then choose it again.                                                                                                                                                                                                                                                                                |
| **▸ YouTube notes**           | Right-click the icon → **YouTube notes** (or the **YouTube notes** button on the Open tabs screen, or a shortcut you bind) opens Chrome's side panel beside the video. **Add note at 1:23** takes the time the video is at (and, if you like, pauses it while you write); notes are listed by time, and clicking a time jumps the video there. **Screenshot** adds a note holding the frame on screen (WebP, at most 1280 px wide), shown as a thumbnail that opens large on a click. Plain text with Markdown kept as typed, `Ctrl+Enter` / `⌘+Enter` saves, edit and delete (with Undo, screenshot included) per note. Stored on this device; synced end-to-end encrypted only if you sign in to sync. |
| **▸ Pinned & suspended tabs** | Pinned tabs stay put unless you say otherwise; tabs suspended by The Marvellous Suspender or a similar suspender sort by their real URL.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **▸ Sessions**                | Right-click the icon → save all windows, or press Save on the app page. One page lists your open tabs, saved sessions and snapshots in the left column, restores exactly (order, pinned, groups, active tab, window state) into new windows or the current one, searches every tab, and imports/exports JSON, Markdown, text, HTML bookmarks or CSV.                                                                                                                                                                                                                                                                                                                                                     |
| **▸ Optional sync**           | Sign in with Google in Settings → Account to keep saved sessions, YouTube notes (screenshots included, up to 100 per account) and settings in step across computers. Everything is encrypted on the device with a passphrase only you know (AES-GCM, key from PBKDF2), so the server stores only ciphertext; snapshots never leave the device. Off until you sign in; **Delete cloud data** removes everything on the server.                                                                                                                                                                                                                                                                            |
| **▸ Snapshots & recovery**    | Every 5 minutes (only when something changed) a snapshot of all open windows is kept locally: the 20 most recent by default, and you choose the interval and how many to keep. **Keep** moves one into your saved sessions for good. After a crash the recovered snapshot is marked in the sidebar. On by default, off in one click.                                                                                                                                                                                                                                                                                                                                                                     |

## The app page

Everything that is not the icon click lives on one page (`app.html`), opened once and re-focused thereafter. Three ways in, none of them on the icon click (a left-click only ever sorts):

1. **Right-click the icon → _Options_**: Chrome's own item, pointed at `app.html#settings`. The same menu carries _Assemble!_, _Save all windows as session_ (a ✓ badge confirms a save), _Pause all YouTube videos_ (✓ once paused; until you have allowed access to YouTube it opens Settings instead) and _YouTube notes_ (the side panel); opening the page is left to Chrome's entry rather than repeated there.
2. **Keyboard shortcuts**: sorting (listed by Chrome as _Activate the extension_: a key bound to it does what a click on the icon does), _Save the current window as a session_, _Open Tabinet_, _Assemble! (move every window's tabs into this one)_, _Pause all YouTube videos_ and _YouTube notes_ are Chrome commands. Sorting is suggested as `Alt+Shift+S`, gathering the windows as `Alt+Shift+A` and pausing YouTube as `Alt+Shift+P` (`⌥⇧S`, `⌥⇧A` and `⌥⇧P` on a Mac), which Chrome assigns only on a new install, never on an update that adds one; the other three have no preset key; bind them at `chrome://extensions/shortcuts` (Settings lists the keys you have assigned).
3. **`chrome://extensions` → Details → Extension options**.

<p align="center">
  <img src="assets/en/dashboard-sessions.png" alt="The Tabinet app page" width="640" />
</p>

<p align="center">
  <img src="assets/en/dashboard-notes.png" alt="A video's YouTube notes on the Tabinet app page, two of them with a screenshot" width="640" />
</p>

The left column is what you have; the rest of the page is whatever you picked. Every view has its own address, so Back works and a session can be bookmarked:

| Address               | View                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `app.html`            | **Open tabs**: every window and tab live; one Save button, plus save, close or jump per window and tab. Tick tabs (shift-click for a range, or **Select all** under a window's header for that whole window) and the heading becomes a bar for just those: save them as a session, copy their links (plain, Markdown, or with titles), close them, save & close, or select every tab on the same site, or on any other.                          |
| `app.html#saved/<id>` | **A saved session**: click the title to rename; Open (new windows) or Open in this window; open one window or one tab; remove a tab or a window; export; delete. Clicking a saved tab that is already open switches to it instead of opening a second copy.                                                                                                                                                                                      |
| `app.html#auto/<id>`  | **A snapshot**: Open, or **Keep** to move it into the saved list. The snapshot taken before a crash is marked _recovered_ in the sidebar.                                                                                                                                                                                                                                                                                                        |
| `app.html#notes/<id>` | **A video's YouTube notes**: every note by time, each time a link to the video at that second (a tab already showing the video is moved there rather than opened twice); edit or delete a note (with Undo); **Export Markdown** saves one `.md` (title, link, then a `### [1:23](link)` section per note with its text and its screenshot inline); **Delete all notes** asks first.                                                              |
| `app.html#search/<q>` | **Search**: open tabs, saved sessions and your YouTube notes; `/` focuses the box from anywhere, `Esc` clears, arrows move, `Enter` opens the highlighted row. Snapshots are searched only when a search finds nothing and you ask for them.                                                                                                                                                                                                     |
| `app.html#settings`   | **Settings**: a dialog over whatever you were looking at: the display language (top right, next to the close button), sorting (Sort by and Duplicate tabs as dropdowns; Custom sorting shows its own options right under Sort by; the rest under Advanced), YouTube (allow or remove the access pausing needs), sessions, backup (export / import / storage / delete everything) and your keyboard shortcuts. Everything saves as you change it. |

Restores run in batches with progress and Cancel; more than 10 tabs load lazily, more than 100 ask first; unopenable URLs are skipped and reported. Export is per group / window / session: JSON (round-trips exactly), Markdown, plain text, Netscape HTML (imports into Chrome bookmarks) or CSV, plus _Copy links_ and _Copy as Markdown_; import takes a file or pasted text with a preview. Light and dark follow your system setting.

Everything lives in `chrome.storage.local` on the device, never in Chrome sync: a database in Chrome's profile folder (`Local Extension Settings/<extension id>/`), whose path Settings > Backup shows under the storage meter with a Copy path button. Export is the readable copy. Only if you sign in to the optional cloud sync are saved sessions, YouTube notes with their screenshots, and settings uploaded, end-to-end encrypted; snapshots never are.

## Languages

English, Korean (한국어), Spanish (Español) and Japanese (日本語). By default (Automatic) Tabinet follows the language Chrome is displayed in, and uses English for any other; the language menu at the top of Settings, next to the close button, picks one of the four instead, for the Tabinet page and the icon's right-click menu. The extension's name and description, the icon's tooltip and the keyboard shortcut descriptions at chrome://extensions always follow Chrome's language, which Chrome reads itself. The choice is stored with your other preferences in Chrome's sync storage. The Chrome Web Store listing comes in the same four languages, picked by Chrome's language. Text you saved (session names, group titles) stays as you wrote it, and exports open and import back the same in every language.

## Privacy

- **No network requests unless you sign in to sync**: works entirely offline, no analytics, no telemetry. The optional cloud sync (off until you click **Sign in with Google** in Settings) sends your Google email and account id to Tabinet's sync server (Vercel and Neon, Singapore) and your saved sessions, YouTube notes (with screenshots) and settings encrypted with a passphrase that never leaves the device; the server cannot read them, and snapshots never sync.
- **Ten permissions, no host permissions at install**: `tabs`, `tabGroups`, `storage` (settings via Chrome sync; sessions in local storage on this device), `contextMenus` (icon menu), `unlimitedStorage` (large sessions), `favicon` (site icons from Chrome's local cache), `alarms` (snapshot and sync timers; none exists when snapshots are off and you are not signed in), `scripting` (pausing YouTube, and reading a video's time and title, or its frame for a screenshot, for YouTube notes), `sidePanel` (the YouTube notes panel), `identity` (Sign in with Google for the optional sync, `openid` and `email` scopes only; never used unless you sign in). Plus one optional host permission, `https://*.youtube.com/*`, asked for only when you turn on **Access to YouTube** in Settings or in the notes panel, and removable in Settings. Requires Chrome 123 or newer.
- **No content scripts**: nothing is injected into a web page, except on YouTube once you allowed it: **Pause all YouTube videos** runs one packaged function in your YouTube tabs that presses pause, and **YouTube notes** runs one that reads the video's time and title and moves it to a note's time, and one that draws the frame on screen when you press **Screenshot**. Nothing else is read, and notes leave the device only through the encrypted sync, if you sign in.
- Full policy: [PRIVACY_POLICY.md](PRIVACY_POLICY.md), also on the [website](https://thilllon.github.io/tabinet/privacy/) in English, Korean, Spanish and Japanese.

Everything typed into the store dashboard (each language's description, the privacy answers, the reviewers' test instructions) is kept as data at the top of [`scripts/store-listing.ts`](scripts/store-listing.ts); `pnpm store:bundle` gathers it with the screenshots into one `SUBMIT.md`.

## Development

### Setup

```shell
pnpm install
pnpm dev
```

### Load in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and select the `dist` folder

### Scripts

```shell
pnpm dev                    # Start Vite dev server (port 5173)
pnpm build                  # Vite build -> dist/ (no type check; run typecheck separately)
pnpm typecheck              # Type check only (tsc --noEmit, then src/tests with Node types)
pnpm format                 # oxfmt over the whole repository (format:check in CI)
pnpm lint                   # oxlint
pnpm test                   # Run tests (vitest)
pnpm release                # release-it: regenerate CWS assets, bump version, build, ZIP, GitHub release
pnpm site:dev               # The project website (site/, Astro) on a dev server
pnpm site:build             # Build the website into site/dist/
```

The website at [thilllon.github.io/tabinet](https://thilllon.github.io/tabinet/) lives in `site/` and is deployed to GitHub Pages by `.github/workflows/pages.yml` on every push to `main` that changes it.

The `dist` folder will contain the production-ready extension.
