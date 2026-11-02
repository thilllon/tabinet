# AGENTS.md

## Project Overview

**Tabinet** is a Chrome extension (Manifest V3) that sorts and organizes browser tabs and saves/restores sets of windows and tabs as sessions. It groups tabs by hostname/domain, handles duplicate tabs, supports suspended tab detection, and keeps a local session store (saved sessions plus automatic history snapshots, on by default) with unified search, import and export, plus an optional, end-to-end encrypted cloud sync of saved sessions and settings (off until the person signs in with Google in Settings > Account; see "Cloud sync"). On request it also pauses every playing video in every YouTube tab ("Pause all YouTube videos", behind an optional host permission the person grants in Settings). Everything else is entirely local: without a sign-in to sync the extension makes no network requests, and snapshots never leave the device.

- Repository: `https://github.com/thilllon/tabinet`
- Chrome Web Store: `https://chromewebstore.google.com/detail/bmbpmnfhfbdjdjpblimidmbohgccmjdg`
- License: Private

---

## Architecture

### Runtime Model

This is a **Chrome Extension** with three execution contexts:

1. **Background Service Worker** (`src/service-worker.ts`) - The core engine. Runs as a Manifest V3 service worker. It is one file and the only one the worker loads directly; it holds the event wiring and nothing else, and calls into `src/lib/`. It registers, synchronously at module top level, every listener: the icon click (`chrome.action.onClicked`), which runs `sortTabGroups()` from `src/lib/sort-tabs.ts` (sorting, grouping and duplicate detection), and the sessions listeners: `runtime.onInstalled` (recreate context menus; `sessionRepo.migrateAll()` when `details.reason === 'update'`, then `sessionRepo.reconcile()`, then `ensureHistoryAlarm()`), `runtime.onStartup` (clear badge, recreate context menus so their titles follow the current language, reconcile, `promoteRecoveredSnapshot()`, re-arm the periodic alarm, one-shot `history-first` alarm), `contextMenus.onClicked` and `commands.onCommand` (save window / save all / open dashboard / gather all windows into the focused one - `assemble-tabs`, logic in `src/lib/assemble-tabs.ts` / pause every YouTube video - `pause-youtube`, logic in `src/lib/pause-youtube.ts`), `alarms.onAlarm` (`takeHistorySnapshot({ origin: 'alarm' })`), a **second** `action.onClicked` listener (fire-and-forget `takeHistorySnapshot({ origin: 'manual' })` alongside the sort, which it never awaits or alters) and `storage.onChanged` (re-arm or clear the alarm when `sessionSettings` changes; put the new language in use and re-title the menus when `uiLanguage` changes in sync storage). The worker wakes only on those events - plus the history alarm while snapshots are enabled (the default); with snapshots off no alarm exists and it wakes on user actions only. There are **no** `chrome.tabs.on*` / `chrome.windows.on*` / `chrome.tabGroups.on*` listeners in the worker.
2. **The app page** (`src/pages/`, rendered in `app.html`) - one React SPA for everything that is not the icon click; there is no separate options page since v7.2.0. `app.tsx` owns the hash route (`src/lib/app-route.ts`: `#open`, `#saved/<id>`, `#auto/<id>`, `#search/<q>`, `#settings`, `#settings/youtube`), the session index, the restore hook and the search state; the sidebar (`SidebarNav`) lists open tabs, saved sessions and - folded away, marked "recovered" after a restart - the snapshots. The main pane is one of: `OpenTabsView` (live `OpenWindowsPane`, one Save button), `SessionDetail` (rename, open, open one window, remove a tab/window, export, delete), `SnapshotDetail` (open, **Keep** = move into the saved list, delete), or `SearchResults`. Settings is not a pane: `#settings` draws `SettingsView` as a dialog over whichever of those was showing (the language menu on its title row, left of the ×; sort settings as dropdowns, the Custom-only ones indented under Sort by and shown only for Custom, the rest under "Advanced"; the YouTube access (allow / remove, for "Pause all YouTube videos"); session settings one per line; backup + `StorageMeter`; and the keyboard shortcuts Chrome reports). Every control writes as it changes - no Save button anywhere. It **runs restores in the page** (never in the service worker, so the worker's idle/lifetime limits do not apply) and talks to `chrome.*` directly - there is no message passing to the worker. `openDashboard()` (`src/lib/open-app-page.ts`) is a singleton: it focuses an existing app tab or creates one. `followSystemTheme()` (`src/lib/theme.ts`) runs once at startup; there is no theme control.
3. **Shared code** (`src/components/`, `src/hooks/`, `src/lib/`) - the components, hooks and logic the pages and the worker are built from (`WindowTree`, `ExportMenu`, `ImportDialog`, `ProgressToast`, `useSessionIndex`, `useSessionBody`, `useRestore`, `useOpenWindows` (which registers `chrome.tabs/windows/tabGroups.on*` listeners _in the page_), `useSearchCorpus`, and every module in `src/lib/`). None of it owns a page or registers a worker listener.

There is **no popup**, **no content script** (nothing under `content_scripts`, no `host_permissions`), **no message-passing protocol** and no server other than the optional sync server (`server/`, reached only after the person signs in to cloud sync). The extension icon click directly triggers sorting and nothing else. The one thing that ever runs inside a web page is `pauseVideosInPage` from `src/lib/pause-youtube.ts`, injected with `chrome.scripting.executeScript` into YouTube tabs when the person chooses "Pause all YouTube videos", and only once they granted the optional `https://*.youtube.com/*` host permission in Settings.

### Data Flow

Sorting (unchanged):

```
User clicks extension icon
-> chrome.action.onClicked listener (src/service-worker.ts)
-> sortTabGroups() (src/lib/sort-tabs.ts)
-> Load settings from chrome.storage.sync
-> Query pinned tabs, tab groups, ungrouped tabs
-> Sort each set independently
-> Move tabs via chrome.tabs.move()
-> Handle duplicates (close or group)
```

Gathering every window into the focused one (`assemble-tabs` - right-click "Assemble!" or the command):

```
Right-click icon → "Assemble!" / keyboard shortcut the user bound at chrome://extensions/shortcuts
-> handleMenuOrCommand('assemble-tabs') (src/service-worker.ts) -> assembleTabs() (src/lib/assemble-tabs.ts)
-> ignored while a run is in progress; nothing to do with a single normal window
-> chrome.windows.getLastFocused({ populate: true, windowTypes: ['normal'] })  // target + its active tab id
-> pickSourceWindows() (pure: other normal windows with the same incognito mode)
-> per source window, planWindowMoves() (pure), replayed in order:
   park the source's active tab on an ungrouped anchor (chrome.tabs.update active, in the source)
 - or, in a window of groups only, chrome.tabs.ungroup the active tab (re-collapsing its group)
   ungrouped runs: chrome.tabs.move(ids); groups: chrome.tabGroups.move(groupId)  // appended
   pinned tabs: chrome.tabs.move(ids) then chrome.tabs.update(id, { pinned: true }) in order
   the anchor last: chrome.tabs.move to its place, or back into its group (chrome.tabs.group)
   (a failing window is recorded and skipped; the rest continue; emptied windows close themselves)
-> restoreTargetView(): race safety net only - normally nothing to put back
-> chrome.windows.update(target, { focused: true }) -> ✓ badge, or ! when any window failed
```

Pausing every YouTube video (`pause-youtube` - right-click "Pause all YouTube videos" or the command):

```
handleMenuOrCommand('pause-youtube') (src/service-worker.ts)
-> hasYoutubeAccess() (chrome.permissions.contains, src/lib/pause-youtube.ts)
   no  -> openDashboard('#settings/youtube'): Settings scrolled to its YouTube row, "Allow access"
          focused and a hint saying why it opened (youtubeAccessHintKey()); the button calls
          requestYoutubeAccess() from the click (chrome.permissions.request needs a user gesture,
          so the worker never asks itself), and the notice after a grant says to run it again;
          nothing is injected
   yes -> pauseYoutubeTabs(): chrome.tabs.query({ url: YOUTUBE_ORIGINS }) -> pausableTabIds() (pure:
          youtube.com over https, not discarded/unloaded; a frozen tab is kept) -> per tab, in
          parallel, chrome.scripting.executeScript({ func: pauseVideosInPage }) (pauses every
          playing <video>/<audio>, returns the count; a failing tab is recorded, the rest
          continue; a tab silent for PAUSE_ANSWER_TIMEOUT_MS, e.g. frozen, counts as unanswered)
-> no badge when no YouTube tab is open, ! when every tab failed, ✓ otherwise (also when nothing
   was playing). Never a toggle: running it again resumes nothing.
```

Saving a session:

```
Right-click icon menu item / keyboard command / the app page's Save button
-> handleMenuOrCommand(id) (src/service-worker.ts) or src/pages/app.tsx
-> captureSession('window' | 'all' | { windowId }) (src/lib/session-capture.ts)
-> chrome.windows.getAll({ populate: true, windowTypes: ['normal'] })
-> chrome.tabGroups.query({})
-> captureWindows(windows, groups, options) (pure: drops incognito, own pages, empty windows;
   unwraps suspended tabs; groups by first appearance)
-> sessionRepo.put(session) (src/lib/session-repo.ts, under the Web Lock)
-> chrome.storage.local.set({ 'session:<id>': body })  // body first
-> chrome.storage.local.set({ sessionIndex })          // then index (newest first)
-> showSavedBadge() (worker only; cleared after 2 s and at the start of every handler)
```

Restoring a session (the app page only):

```
Open (session-detail / snapshot-detail) -> useRestore()
-> sessionRepo.get(id) + sessionRepo.getSettings()
-> planRestore(session, { target, lazy, sanitize }) (pure: sanitizeRestoreUrl, chunks of 25)
-> executeRestore(plan, { onProgress, signal, screen })
-> windows.create placeholder -> tabs.create per chunk (retry once on "cannot be edited")
-> tabs.discard non-active/non-pinned when lazy -> tabs.group + tabGroups.update after all tabs
-> collapse groups -> activate -> remove placeholder -> apply minimized/maximized/fullscreen
-> ProgressToast with restored / skipped / errors
```

History snapshot (service worker; the alarm, or the icon click while snapshots are on):

```
alarms.onAlarm('history-snapshot' | 'history-first') / second action.onClicked listener
-> takeHistorySnapshot({ origin }) (src/lib/history-snapshots.ts)
-> sessionRepo.getSettings(): 'disabled' when historyEnabled is false (no window query at all)
-> captureSession('all') -> contentHash(windows) vs historyMeta.lastHash -> 'skipped-unchanged'
-> sessionRepo.put({ kind: 'history', name: defaultHistoryName(...) })  // sessionSnapshotDefaultName, in the UI language
-> sessionRepo.pruneHistory(historyMaxSnapshots)   // oldest unprotected history first; never 'saved'
-> sessionRepo.setHistoryMeta({ lastHash, lastSnapshotAt })
```

Search, export and import run entirely in the app page: `useSearchCorpus` builds `SearchEntry[]` per session body (pre-warmed on idle, invalidated per key by `storage.onChanged`) plus the open-windows snapshot and feeds `search()` from `src/lib/search-engine.ts`; `ExportMenu` calls the pure serializers in `src/lib/session-export.ts` and hands the text to `src/lib/download-and-copy.ts` (Blob URL + `<a download>` - no `downloads` permission) or to the clipboard; `ImportDialog` runs `importSessions()` from `src/lib/session-import.ts` (type guards in `import-guards.ts`), shows a preview, then `sessionRepo.put()` per session.

Sort settings are persisted in `chrome.storage.sync` and loaded fresh on every sort invocation. Session data and `sessionSettings` live in `chrome.storage.local` and are read through `sessionRepo` only. The dashboard reloads its list when `chrome.storage.onChanged` reports a change to `sessionIndex`, and `useSessionSettings` re-reads on a `sessionSettings` change.

### Directory Structure

```
tabinet/
├── src/
│   ├── app.html                # The extension page, the only HTML entry (Vite `root` is src/, so it builds to dist/app.html)
│   ├── service-worker.ts       # The manifest's service worker, the only file loaded there: every chrome event listener
│   │                           #   (icon click: sort + history snapshot; install/startup; menus; commands; alarms;
│   │                           #   storage.onChanged), badges, MENU_IDS / COMMAND_IDS. Wiring only; the work is in lib/
│   ├── pages/                  # Screens: the one extension page (app.html) and its views
│   │   ├── index.tsx           # React entry point (app.html)
│   │   ├── app.tsx             # Routing, sidebar + main pane, dialogs, notices
│   │   ├── open-tabs-view.tsx    # Live windows, Save, Assemble!, the tab selection
│   │   ├── session-detail.tsx   # One saved session
│   │   ├── snapshot-detail.tsx  # One history snapshot
│   │   └── settings-view.tsx    # The content of the Settings dialog
│   ├── components/             # Every hand-made component, flat: SidebarNav, SidebarResizer, SavedToasts, WindowTree,
│   │   │                       #   GroupSection, TabRow, Favicon, SelectMenu, ProgressToast, OpenWindowsPane,
│   │   │                       #   SelectionBar, WindowSelectAll, SearchBar, SearchResults, ExportMenu, ImportDialog, StorageMeter,
│   │   │                       #   QuotaNotice, SessionSettingsFields, UnreadableSessionRow, RestoreConfirmDialog,
│   │   │                       #   DeleteSessionDialog, DeleteAllHistoryDialog, DeleteAllDataDialog,
│   │   │                       #   CloseWindowDialog, CloseTabsDialog, DialogCloseButton, and the Settings dialog's pieces:
│   │   │                       #   SettingsSection, SettingsField, AdvancedFold, ShortcutKeyChips, YoutubeAccessField,
│   │   │                       #   AccountField, DeleteCloudDataDialog
│   │   └── ui/                 # Stock shadcn/ui only, added with the CLI (button, label, input, dialog, dropdown-menu,
│   │                           #   badge, collapsible, switch, select). Never a custom component
│   ├── hooks/                  # React hooks, flat: useRoute (the hash route), useSessionIndex, useSessionBody,
│   │                           #   useSessionSettings, useRestore, useOpenWindows (page-side tab listeners),
│   │                           #   useSearchCorpus, useSavedToasts, useYoutubeAccess (follows chrome.permissions),
│   │                           #   useCloudAccount (the cloud sync account, page-side storage.onChanged),
│   │                           #   useCloudSync (last sync time / error + Sync now)
│   ├── lib/                    # All logic, flat (one level, no subfolders); tests for each module are in src/tests/
│   │   ├── sort-tabs.ts        # sortTabGroups(): the icon-click sort orchestration, Chrome API calls, duplicates
│   │   ├── sort-order.ts             # Pure sorting/grouping logic
│   │   ├── move-plan.ts        # Pure: which chrome.tabs.move calls reorder a block, moving only what is out of place
│   │   ├── sort-settings.ts    # DEFAULT_SORT_SETTINGS, parseSortSettings(), SORT_SETTING_KEYS
│   │   ├── assemble-tabs.ts         # assemble-tabs: move other windows' tabs into the focused one
│   │   ├── pause-youtube.ts         # pause-youtube: the YouTube access (chrome.permissions) and pausing every YouTube tab
│   │   ├── cloud-config.ts / cloud-crypto.ts / cloud-api.ts / cloud-auth.ts  # cloud sync, on in this build
│   │   │                       #   but opt-in per person (see "Cloud sync"): config getter, passphrase + AES-GCM, server client, sign-in
│   │   ├── cloud-sync.ts / cloud-sync-state.ts  # the sync engine (syncNow, triggers) and its bookkeeping (cloudSyncMeta)
│   │   ├── session-naming.ts           # defaultSessionName(), ensureUniqueName(), slugify()
│   │   ├── session-migrate.ts          # migrateSession(), migrateIndex(), UnknownSchemaVersionError
│   │   ├── session-hash.ts             # contentHash(): FNV-1a over urls/pinned/group index/group title
│   │   ├── session-capture.ts          # captureWindows()/captureWindowsWithIds() (pure) + captureSession()
│   │   ├── session-repo.ts          # sessionRepo, withLock(), storage keys: the ONLY writer of session data
│   │   ├── session-restore.ts          # sanitizeRestoreUrl(), clampToScreen(), planRestore() (pure), executeRestore()
│   │   ├── suspended-url.ts        # isSuspendedUrl() / unwrapSuspendedUrl(): any suspender's page, by shape (sort + capture + restore)
│   │   ├── history-snapshots.ts          # takeHistorySnapshot(), promoteRecoveredSnapshot(), ensureHistoryAlarm(), scheduleFirstSnapshot()
│   │   ├── search-engine.ts           # tokenizer / matcher / ranker over SearchEntry[] (open > saved > history)
│   │   ├── session-export.ts           # toJson/toMarkdown/toText/toHtml/toCsv, scopeToSession(), exportFilename()
│   │   ├── session-import.ts           # detectFormat(), parseJson/parseNetscapeHtml/parseTextOrMarkdown, importSessions()
│   │   ├── import-guards.ts           # hand-written type guards for external data (isSession, isExportBundle, …)
│   │   ├── open-app-page.ts   # openDashboard(hash?) singleton
│   │   ├── open-shortcut-settings.ts        # openShortcutSettings(): chrome://extensions/shortcuts
│   │   ├── app-route.ts            # hash routes (#open, #saved/<id>, #auto/<id>, #search/<q>, #settings), viewBelow()
│   │   ├── theme.ts            # followSystemTheme()/withDarkClass(): dark mode follows the OS, no setting
│   │   ├── ui-language.ts      # The language chosen in Settings ('auto' | SupportedLocale, sync key `uiLanguage`):
│   │   │                       #   parseUiLanguage(), load/saveUiLanguage(), applyStoredUiLanguage(), uiLanguageOptions(),
│   │   │                       #   followUiLanguageChanges() (page), languageSaveFailedMessage()
│   │   ├── utils.ts            # cn() utility (clsx + tailwind-merge)
│   │   ├── i18n.ts             # t(key, ...subs), tp(base, count, ...extra), uiLocale(), formatNumber(), joinSentences(),
│   │   │                       #   joinFacts(): every string
│   │                           #   a person reads, through chrome.i18n or the chosen language's catalog
│   │                           #   (applyUiLanguage(), uiLanguageReady(), appliedUiLanguage(), formatMessage();
│   │                           #   see Internationalization)
│   │   └── …                   # Page-side helpers: assemble-notice, command-rows, display-format, download-and-copy,
│   │                           #   error-message, export-actions, group-colors, ime-composition, import-preview,
│   │                           #   open-in-background, open-saved-tab, open-windows, restore-progress,
│   │                           #   restore-summary, row-actions, row-link, sanitize-options, save-notice, search-corpus,
│   │                           #   search-nav, session-edit, session-list, session-settings, settings-change-event,
│   │                           #   shortcut-keys, sidebar-width, storage-meter, storage-quota, tab-paging,
│   │                           #   tab-segments, tab-selection, toast-queue, ui-state (sessionStorage),
│   │                           #   window-actions
│   ├── styles/
│   │   └── index.css           # Tailwind CSS with the shadcn theme tokens + the .cv-* content-visibility rules
│   ├── constants.ts            # Plain data: DEFAULT_SHORTCUTS (suggested keys by command id), LAZY_AUTO_THRESHOLD,
│   │                           #   YOUTUBE_ORIGINS (the optional host permission; the manifest spreads it),
│   │                           #   SUPPORTED_LOCALES / SupportedLocale / DEFAULT_LOCALE / LOCALE_ENDONYMS (the one list of
│   │                           #   shipped languages; scripts, tests and site/ derive theirs from it),
│   │                           #   imported by vite.config.ts, so no chrome.* and no src imports
│   ├── types.ts                # Shared TypeScript types (SortSettings + Session* types)
│   ├── global.d.ts             # Vite client type declarations
│   └── tests/                  # Every unit test, flat: <module>.test.ts for src/lib/<module>.ts and the hooks
│       ├── setup.ts            # vitest setupFiles: installs the fake on globalThis.chrome + navigator.locks shim
│       ├── chrome-fake.ts      # Typed in-memory chrome.* fake (storage, tabs, windows, tabGroups, menus, alarms)
│       ├── chrome-fake.test.ts # Tests for the fake itself
│       ├── cloud-fetch.ts      # Fake sync server for the cloud tests (canned answers, and fakeSyncServer() with the
│       │                       #   real records semantics: last writer wins, seq, since paging, limits); not a test file
│       ├── service-worker.test.ts  # The worker's listeners and handlers against the chrome fake
│       ├── service-worker-sort.test.ts # Icon click against the chrome fake: order, no-op when sorted, single move, double click
│       ├── i18n.test.ts        # _locales parity: same keys and $n in every language, descriptions, no long dashes
│       ├── store-listing.test.ts   # scripts/store-listing.ts: Description/Summary limits per language, justifications = manifest permissions
│       ├── …                   # sort, move-plan, assemble, storage, restore, history, capture, … one file per module
│       └── tsconfig.json       # Type-checks the tests with node types (`pnpm typecheck` runs it as a second tsc pass)
├── public/
│   ├── _locales/              # chrome.i18n messages, copied to the extension root: en (default_locale, every key),
│   │   └── <lang>/messages.json #   ko, es, ja; manifest name/description/commands are __MSG_<key>__ references
│   └── img/                   # Extension logos (SVG, 16/32/48/128px PNG)
├── scripts/
│   ├── e2e/                   # Committed real-Chrome QA harness (tsx, not vitest)
│   │   ├── smoke.ts           # 11-step sessions smoke test: pnpm build && pnpm exec tsx scripts/e2e/smoke.ts
│   │   ├── assemble.ts        # assemble-tabs checks against an e2e build: pnpm e2e:assemble
│   │   ├── sort.ts            # icon-click sort checks (order, groups, how many tabs moved): pnpm build && pnpm e2e:sort
│   │   ├── selection.ts       # Open tabs selection checks (tick, range, copy, close, save & close): pnpm build && pnpm e2e:selection
│   │   ├── browser.ts         # launchExtension() - a real Chromium with dist/ loaded (shared with screenshots)
│   │   ├── server.ts          # startDemoServer() - 127.0.0.1 fixture pages (the QA browser has no network)
│   │   └── fixtures.ts        # Session fixtures seeded straight into chrome.storage.local
│   ├── zip.ts                 # Packages dist/ into release/Tabinet-<version>.zip for Web Store (archiver 8)
│   ├── zip-name.ts            # zipFileName(): the zip's name from package.json displayName, never the manifest's
│   │                          #   __MSG_extName__ (shared with store-bundle.ts; test in src/tests/)
│   ├── prepare-registration.ts # Store-asset pipeline (build, Settings + the four dashboard-*.png screenshots,
│   │                          #   promo images); every optional step has a SKIP_* flag;
│   │                          #   LOCALES=en,ko,es,ja shoots Settings + dashboard per UI language into assets/<code>/
│   ├── check-dashes.ts        # Fails on an em or en dash in any tracked file (run by `pnpm lint`)
│   ├── store-listing.ts       # Every text typed into the CWS dashboard, as data at the top (Descriptions per
│   │                          #   language, details, privacy answers, test instructions); LISTING_LOCALES, limits
│   ├── store-bundle.ts        # Gathers zip, screenshots (screenshots/<lang>/), promo images and a SUBMIT.md
│   │                          #   holding all of the above into release/store-<version>/
│   └── promo-template.html    # HTML template for CWS promotional images
├── assets/                    # CWS assets: Settings + dashboard-*.png screenshots and promo images (generated);
│                              #   before/after-sort.png and demo.gif/.mp4 (frozen, no longer regenerated);
│                              #   <code>/ holds another UI language's Settings + dashboard screenshots, same names
├── site/                      # The project website (Astro, static), its own pnpm workspace package
│   │                          #   `tabinet-site`; see "Project website" below
│   ├── astro.config.ts        # site + base (/tabinet), i18n (en default, ko, es, ja), sitemap
│   └── src/
│       ├── pages/[...locale]/ # index, support, privacy, once per language (en has no prefix); robots.txt.ts, 404
│       ├── i18n/          # locales.ts (URLs, store/repo links), site-copy.ts (the SiteCopy type),
│       │                      #   copy-en/ko/es/ja.ts (every string of the site, per language),
│       │                      #   screenshots.ts (per-language assets/ screenshots)
│       ├── privacy/       # ko.md, es.md, ja.md: translations of PRIVACY_POLICY.md (English is rendered from it)
│       ├── components/    # header, footer, language switch, Add to Chrome button, icons
│       ├── layouts/       # base-layout.astro: head (canonical, hreflang, Open Graph), header, footer
│       └── styles/global.css  # the extension's colour tokens, light and dark by prefers-color-scheme
├── server/                    # The sync server (Vercel + Postgres), its own pnpm workspace package
│                              #   `tabinet-server`; see "Sync server" below
├── .github/
│   ├── workflows/
│   │   ├── ci.yml             # CI pipeline (typecheck, format, build; tools via mise)
│   │   ├── codeql.yml         # CodeQL security scanning
│   │   ├── pages.yml          # Builds site/ and deploys it to GitHub Pages
│   │   └── dependabot-auto-merge.yml # Turns auto-merge on for Dependabot's minor/patch PRs
│   └── dependabot.yml         # Weekly npm + GitHub Actions updates (minor/patch grouped)
├── vite.config.ts             # Vite + CRX plugin config (manifest defined here); `root: src`, `publicDir` and `outDir` back at the repository root
├── tsconfig.json              # TypeScript config (strict mode)
├── tsconfig.node.json         # TypeScript config for vite.config.ts
├── .oxfmtrc.json              # oxfmt: formats every file type it knows (TS/TSX/JS, JSON, Markdown, YAML, TOML, CSS, HTML)
├── .oxlintrc.json             # oxlint: correctness rules + the React/a11y rules the code honours
├── .gitleaks.toml             # gitleaks: the default secret rules, generated output (dist, release, assets, lockfile) left out
├── .release-it.json           # release-it config (hooks run prepare-registration, build, zip)
├── lefthook.yml               # Git hooks (pre-commit: gitleaks, format, lint, dashes; pre-push: typecheck/test/build/docs)
├── mise.toml                  # Tool versions (Node, pnpm, lefthook, gitleaks)
├── components.json            # shadcn/ui configuration
├── PRIVACY_POLICY.md          # Privacy policy (update when permissions change)
└── package.json
```

**Layout rules (set by the owner).** `src/pages/` holds screens (the page entry, `app.tsx` and its views); `src/components/` holds every hand-made component, flat; `src/components/ui/` holds stock shadcn/ui components only, as the CLI writes them, and never a custom component (a component built on top of one goes in `src/components/`); `src/hooks/` holds React hooks, flat; `src/lib/` holds all logic, one level only with no subfolders; `src/styles/index.css` is the one stylesheet; `src/service-worker.ts` is the worker. Tests live in `src/tests/`, flat, never next to their source. A new file goes in the folder its kind names, not next to whatever uses it. So a file in `src/pages/` is one screen component and nothing else: its own `Props` interface (not exported) and private constants. A non-React function it needs, even one only it calls, goes to `src/lib/` (tested in `src/tests/` when it decides something); a hook to `src/hooks/use-*.ts`; a sub-component to `src/components/`. Export only what another file imports - tests count, so a pure half exported for its unit test stays exported.

**File names are kebab-case everywhere** (`sidebar-nav.tsx`, `use-open-windows.ts`, `session-repo.ts`, `close-tabs-dialog.test.ts`), the convention the stock shadcn files in `src/components/ui/` already use. What is inside follows TypeScript and React: components are PascalCase (`SidebarNav`), hooks and functions camelCase (`useOpenWindows`, `sortTabGroups`), constants UPPER_SNAKE_CASE. Name a lib file for what it holds (`session-repo.ts`, not `storage.ts`): with one flat folder, a generic name says nothing.

---

## Key Source Files

### `src/lib/sort-tabs.ts`: Sort orchestration & Chrome APIs

Handles settings loading, Chrome API calls (`tabs.move`, `tabs.group`, `tabGroups.update`), and duplicate tab handling for the icon click; the listener that calls `sortTabGroups()` is in `src/service-worker.ts`. Imports pure sorting logic from `sort-order.ts`.

| Function                | Purpose                                                                                                                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sortTabGroups()`       | Main orchestrator. Loads settings, queries tabs, delegates to sort functions, handles duplicates.                                                                                  |
| `sortTabs()`            | Sorts a set of tabs, then runs the `planMoves()` batches from `move-plan.ts` - no call at all when the order is already right. Dispatches to `sortByTitleOrUrl` or `sortByCustom`. |
| `handleDuplicateTabs()` | Finds duplicate URLs and either closes extras or groups them.                                                                                                                      |
| `closeDuplicateTabs()`  | Keeps active/first tab, closes the rest.                                                                                                                                           |
| `groupDuplicateTabs()`  | Groups duplicate tabs into a Chrome tab group.                                                                                                                                     |

### `src/lib/assemble-tabs.ts` - Gather all windows into one

Moves every tab of the other normal windows into the last-focused normal window. **Only `chrome.tabs.move` / `chrome.tabGroups.move`** - never reopen by URL and close, never duplicate - so tab ids, history and page state survive and a failed call leaves a tab in its window. Pure halves: `pickSourceWindows(windows, target)` (other `type: 'normal'` windows with the target's `incognito`) and `planWindowMoves(tabs)` (see below). `assembleTabs()` runs them per source window with a per-window try/catch and one retry on "Tabs cannot be edited right now" (`withRetryOnce` from `src/lib/session-restore.ts`), guarded by a module-level in-progress flag. Chrome behaviours it depends on, verified in a real browser (see Real-Chrome QA): a cross-window `tabs.move` drops `pinned` (re-pin in order and each lands at the end of the target's pinned area); `tabGroups.move` keeps the group id, title, colour and collapsed state - **but** a group holding its source window's active tab makes that tab the target's active tab and expands the group (`tabs.move` never activates anything). The owner's rule is that the target's active tab never changes, not even for a moment, so this is prevented, not repaired: before any group moves, the source window's active tab is parked on an ungrouped anchor that moves last - the active tab itself when ungrouped, else a pinned tab (the pinned block then moves last), else the last ungrouped tab (moved last to just before the tab that followed it). Activating an ungrouped tab expands nothing; activating a tab inside a collapsed group would expand it. A window of groups only takes its active tab out of its group (`tabs.ungroup`; from the middle of a collapsed group that expands the group, which is collapsed again at once), moves the groups, then puts the tab back into the same group at the same offset (`rejoin`). A single-tab group vanishes when emptied, so it is rebuilt with the same title, colour and collapsed state (`regroup` - the one case where the group id changes). `restoreTargetView()` is only a safety net for races (e.g. the user activating a tab in a window that is still being emptied).

### `src/lib/sort-order.ts` - Pure Sorting Logic

Contains all pure sorting and grouping functions, extracted for testability. No Chrome API side effects. Both sorts build one `TabSortKey` per tab (pinned, suspended, group position, text) through `sortedByKey()` instead of parsing urls inside the comparator, and every text comparison goes through one module-level `Intl.Collator` - the same result as argument-less `localeCompare`. They still reorder the array they are given.

### `src/lib/move-plan.ts` - Which tabs to move

Pure. `planMoves(current, desired)` returns the `chrome.tabs.move` calls (`MoveBatch[]`, indices relative to the block's first tab) that turn one order of a contiguous block into another, and `[]` when nothing is out of place. It prices two candidates as _tabs displaced + calls_ and takes the cheaper: `fewestDisplaced` keeps the longest already-ordered run (`longestIncreasingRun`, patience sorting) and moves only the rest, joining moves onto consecutive indices into one call; `wholeBlock` is the single call the sorter always made, which wins when the order is thoroughly shuffled. The weights are measured, not guessed (Chrome for Testing 153, 300 tabs): a tab that really changes place costs about 1.2 ms, a tab asked to move to where it already is costs almost nothing, and a call that moves something adds about one more tab's worth. `applyMoves()` models Chrome's block move for the tests; `isContiguous()` is the guard `sortTabs()` uses before trusting relative indices (otherwise it falls back to the whole-block call). A plan is only right for the order it was made from, so the sorting `action.onClicked` listener in `src/service-worker.ts` chains runs on a module-level promise (`sortQueue`): a double click sorts twice in sequence, never side by side (`src/tests/service-worker-sort.test.ts`).

| Function               | Purpose                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------- |
| `sortByTitleOrUrl()`   | Sorts tabs alphabetically by title or URL. Handles suspended tab grouping and pinned tab exclusion.     |
| `sortByCustom()`       | Groups tabs by hostname/domain, preserving first-seen order. Supports LTR/RTL grouping direction.       |
| `findDuplicateTabs()`  | Returns a `Map<url, Tab[]>` of URLs with more than one tab.                                             |
| `extractGroupingKey()` | Parses hostname into grouping key. In `domain` mode, handles two-part TLDs (e.g., `co.uk`).             |
| `isSuspended()`        | Whether a tab shows a tab suspender's page (`isSuspendedUrl()` from `suspended-url.ts`, any suspender). |
| `tabToUrl()`           | The url a tab sorts by: a suspended tab's real url, unwrapped verbatim by `unwrapSuspendedUrl()`.       |
| `urlSortKey()`         | The text a url sorts by (hostname without `www.`, then path, query, hash), computed once per tab.       |
| `sortedByKey()`        | Stable decorate-sort-undecorate: derives each item's key once, compares keys only, returns a new array. |
| `hashStringToColor()`  | Deterministically maps a string to a Chrome tab group color.                                            |
| `updateTabGroupMap()`  | Tracks first-seen ordering of tab groups by hostname/domain grouping key.                               |

### `src/service-worker.ts`: The service worker

The manifest's `background.service_worker` and the only module loaded there. Registers every listener synchronously at module top level: the sorting `action.onClicked` (chained on `sortQueue`, calls `sortTabGroups()`), and the listeners in the table below. It holds wiring only; the work is done by `src/lib/`. Exports for tests: `MENU_IDS = { assembleTabs: 'assemble-tabs', saveAll: 'save-all', pauseYoutube: 'pause-youtube' }`, `COMMAND_IDS = { saveSession: 'save-session', openDashboard: 'open-dashboard', assembleTabs: 'assemble-tabs', pauseYoutube: 'pause-youtube' }` (must equal the `commands` block in `vite.config.ts`), `registerContextMenus()`, `handleMenuOrCommand(id)`, `showSavedBadge()`, `showErrorBadge()`, `clearBadge()`. A `vite build --mode e2e` build (and only that build - Vite inlines `MODE`, so every other build drops the branch) also sets `globalThis.__tabOrganizerE2e = { handleMenuOrCommand }` so `scripts/e2e/assemble.ts` can trigger a command without a keyboard. Alarm names come from `src/lib/history-snapshots.ts` (`HISTORY_ALARM = 'history-snapshot'`, `HISTORY_FIRST_ALARM = 'history-first'`).

| Listener                                        | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runtime.onInstalled`                           | `clearBadge()`; `registerContextMenus()`: `contextMenus.removeAll()` then create "Assemble! (move every window's tabs into this one)" (`cmdAssembleTabs` in `public/_locales` - the same message is the command's description at chrome://extensions/shortcuts; the Open tabs button shows `assembleName` with it as its tooltip) "Save all windows as session" (`workerMenuSaveAll`) and "Pause all YouTube videos" (`cmdPauseYoutube`, also the command's description) in the UI language (idempotent, no separators, errors caught locally); on `details.reason === 'update'` runs `sessionRepo.migrateAll()` first (errors caught locally); then `sessionRepo.reconcile()`; then `ensureHistoryAlarm()` (Chrome drops every alarm on update/reload). Then `ensureSyncAlarm()` (cloud sync; nothing while unconfigured). |
| `runtime.onStartup`                             | `clearBadge()`; `registerContextMenus()` again (errors caught locally), because Chrome keeps the menu items with the titles of the language they were created in, so a Chrome language changed since the last install or update would otherwise leave them in the old one; `sessionRepo.reconcile()`; `promoteRecoveredSnapshot()` (errors caught locally); `ensureHistoryAlarm(settings)`; `scheduleFirstSnapshot(settings)` (one-shot `history-first`, 1 min out, so the first capture happens after Chrome has restored its tabs). Then `ensureSyncAlarm()` (cloud sync; nothing while unconfigured).                                                                                                                                                                                                                    |
| `contextMenus.onClicked` / `commands.onCommand` | `clearBadge()`; `save-session` (command) → capture current window; `save-all` (menu) → all windows; `open-dashboard` (command) → `openDashboard()`; `assemble-tabs` (menu or command) → `assembleTabs()` (✓ when every window merged, ! and a logged error when any failed, no badge for a single window or a repeat trigger); `pause-youtube` (menu or command) → without the YouTube access `openDashboard('#settings/youtube')` and nothing else, with it `pauseYoutubeTabs()` (✓ when it ran, also with nothing playing; ! when every YouTube tab failed; no badge when none is open; each failing tab logged). A save runs the name through `ensureUniqueName()` and shows `showErrorBadge()` when nothing was capturable or the write failed.                                                                         |
| `alarms.onAlarm`                                | `clearBadge()`; `history-snapshot` / `history-first` → `takeHistorySnapshot({ origin: 'alarm' })`; other alarm names ignored. `takeHistorySnapshot` returns `'disabled'` itself when history is off, so no settings read here. `cloud-sync` / `cloud-sync-soon` (`isSyncAlarm()`) → `syncNow()`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `action.onClicked` (second listener)            | `takeHistorySnapshot({ origin: 'manual' })`, fire-and-forget, concurrent with the sorting listener in the same file (never awaited by it, never alters it). Costs one storage read while history is off. Errors are reported, never thrown - the click must keep sorting.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `storage.onChanged`                             | `areaName === 'local'` and `sessionSettings` in `changes` → `ensureHistoryAlarm()` (re-reads through `sessionRepo.getSettings()` for the same normalisation as every other read). Re-arms on interval change, clears both alarms when history is turned off. `areaName === 'sync'` and `uiLanguage` in `changes` (the language chosen in Settings) → `applyUiLanguage(parseUiLanguage(newValue))` and `registerContextMenus()`, so the menu titles follow at once. Every change goes first to `handleCloudStorageChange()` (cloud sync: alarms on account/key changes, settings dirty tracking, a soon sync on new work; returns at once while unconfigured).                                                                                                                                                               |

Before the listeners, the module body starts `applyStoredUiLanguage()` (`src/lib/ui-language.ts`: one `chrome.storage.sync` read, plus the packaged catalogs when a language is chosen; never rejects). Listener registration stays synchronous; everything that makes text waits on `uiLanguageReady()` from `src/lib/i18n.ts` first - `registerContextMenus()`, the menu/command saves (before the capture names the session), `takeHistorySnapshot()` / `promoteRecoveredSnapshot()` (just before naming, after the capture, so the icon-click snapshot still sees the tabs before the sort), and the icon-click sort's `groupDuplicateTabs()` in `src/lib/sort-tabs.ts` (after `chrome.tabs.group`, before the duplicate group's title, so no move waits). A test for each of these holds the language files back (a gated reader or `fetch`) and checks nothing is named before they arrive.

### `src/lib/` - Session domain modules

| Module                      | Exports                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session-naming.ts`         | `defaultSessionName(date, windowCount, tabCount)`, `ensureUniqueName(name, existingNames)`, `slugify(name)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `session-migrate.ts`        | `migrateSession(record)`, `migrateIndex(record)`, `UnknownSchemaVersionError` (identity for v1; unknown versions throw and the UI shows the record read-only)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `session-hash.ts`           | `contentHash(windows)`, `fnv1a32(input)` - titles excluded, so a title change never produces a new snapshot                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `session-capture.ts`        | `captureWindows(windows, groups, options)` (pure), `captureWindowsWithIds(...)` (same, runtime ids kept, in-memory only - the open-windows pane), `captureSession(scope)` with `CaptureScope = 'window' \| 'all' \| { windowId } \| { tabIds }` (the last: only those live tabs, each kept in its own window - the Open tabs selection)                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `session-repo.ts`           | `sessionRepo` (`listSummaries`, `get`, `getMany` (one batched `storage.local.get` for several bodies; returns the readable ones plus the ids that failed), `put`, `rename`, `update` (read-modify-write under the lock; return `null` to delete), `remove`, `removeAll`, `reconcile`, `migrateAll`, `getSettings`, `setSettings`, `getHistoryMeta`, `setHistoryMeta`, `pruneHistory`, `markRecovered`, `demoteAutoProtected`, `duplicateAsSaved`, `removeAllHistory`), `withLock`, `toSummary`, `INDEX_KEY`, `SETTINGS_KEY`, `HISTORY_META_KEY`, `sessionKey`, `LOCK_NAME`                                                                                                                                                                                                                                            |
| `session-restore.ts`        | `sanitizeRestoreUrl`, `clampToScreen`, `planRestore` (pure), `executeRestore`, `withRetryOnce`, `isTabsCannotBeEditedError`, `isLazyRestore(lazy, tabCount)`, `screenRectOf(screen)`; `RestoreTarget = { kind: 'newWindows' } \| { kind: 'window'; windowId }`; `OpenScope = 'newWindows' \| 'here'` (the app page's Open choice, turned into a `RestoreTarget` by `app.tsx`); `DEFAULT_CHUNK_SIZE = 25` (the automatic lazy threshold, `LAZY_AUTO_THRESHOLD = 10`, is in `src/constants.ts`)                                                                                                                                                                                                                                                                                                                         |
| `suspended-url.ts`          | `isSuspendedUrl(url, ownId?)` - a tab suspender's page recognised by shape, not by a configured id: `chrome-extension://<32 letters a-p>/suspended.html#` with a non-empty `uri=` parameter in the fragment, never a page of our own extension (`ownId` defaults to `chrome.runtime.id`); `unwrapSuspendedUrl(url, ownId?)` - the raw remainder after the first `uri=` parameter (the suspender appends the real url unencoded, so `URLSearchParams` would corrupt it), any other url unchanged. The one place that knows the format                                                                                                                                                                                                                                                                                  |
| `history-snapshots.ts`      | `takeHistorySnapshot({ origin })` → `{ outcome: 'saved' \| 'skipped-empty' \| 'skipped-unchanged' \| 'disabled', sessionId?, pruned }`, `promoteRecoveredSnapshot()` (newest unprotected alarm/manual/startup snapshot captured after the last recovered one → `origin: 'recovered'`, protected, renamed), `ensureHistoryAlarm(settings?)`, `scheduleFirstSnapshot(settings?)`, `defaultHistoryName`, `recoveredSnapshotName`, `HISTORY_ALARM`, `HISTORY_FIRST_ALARM`                                                                                                                                                                                                                                                                                                                                                 |
| `search-engine.ts`          | `SearchEntry`, `SEARCH_SOURCES` (`'open' \| 'saved' \| 'history'`), `entriesFrom*` builders (hostname precomputed once), `search(entries, query, { limitPerSource, includeHistory })` (`DEFAULT_LIMIT_PER_SOURCE = 200`), `splitOnMatches` for result highlighting - lowercase whitespace tokens, AND over title/url/hostname, rank hostname-prefix > title > url, then source order, then recency; per-source `count`/`hasMore`                                                                                                                                                                                                                                                                                                                                                                                      |
| `session-export.ts`         | `ExportScope` (session / window / group), `scopeToSession`, `toJson` (`ExportBundle`), `toMarkdown`, `toText`, `toHtml` (Netscape bookmark file), `toCsv` (`CSV_HEADER = 'session,window,group,index,pinned,title,url'`, RFC 4180 `csvEscape`), `escapeHtml`, `serialize(format, …)`, `exportFilename(base, format, date)` → `tabinet-<slug>-<yyyyMMdd-HHmm>.<ext>`, `extensionFor`, `mimeTypeFor`                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `session-import.ts`         | `ImportFormat = 'json' \| 'html' \| 'markdown' \| 'text'` (CSV is export-only), `detectFormat(text)`, `parseJson`, `parseNetscapeHtml` (own tokenizer - no `DOMParser`, so it runs under vitest), `parseTextOrMarkdown` (blank line = new window, `(pinned)` marker), `importSessions(text, now)` → sessions with fresh ids, `kind: 'saved'`, `origin: 'import'`, name suffix "(imported)" in the UI language (`expImportedName`)                                                                                                                                                                                                                                                                                                                                                                                     |
| `import-guards.ts`          | `isRecord`, `isTabSnapshot`, `isGroupSnapshot`, `isWindowSnapshot` (checks `groupIndex` bounds and ≤ 1 active tab), `isSession`, `isExportBundle` - tolerant of extra fields, strict on required ones; the only validation path for pasted/uploaded data                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `pause-youtube.ts`          | `hasYoutubeAccess()` / `requestYoutubeAccess()` (page only, straight from a click) / `removeYoutubeAccess()` over `YOUTUBE_ORIGINS`; `touchesYoutubeAccess(permissions)` (pure, filters `permissions.onAdded/onRemoved`); `isYoutubeUrl(url)` and `pausableTabIds(tabs)` (pure); `pauseVideosInPage()` (serialized into the page: self-contained, no imports or closures - `chrome-fake.ts` rebuilds it from its source to prove it); `pauseYoutubeTabs({ timeoutMs? })` → `{ tabs, paused, failed, unanswered, failures }` (a frozen tab is asked too, and stops being waited for after `PAUSE_ANSWER_TIMEOUT_MS`; the fake's `freezeTab` / `thawTab` model it); `youtubeAccessHintKey(granted, sentHere)` (pure: the Settings row's hint, incl. why `#settings/youtube` opened). No `chrome.*` at module evaluation |
| `open-app-page.ts`          | `openDashboard(hash?)` - focuses the existing app tab or opens one; with a route such as `#settings` it opens there, or changes an open tab's fragment (no reload) unless it is already there                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `open-shortcut-settings.ts` | `openShortcutSettings()`, `SHORTCUTS_URL` - `chrome.tabs.create({ url: 'chrome://extensions/shortcuts' })`, used by the Settings view                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

### `src/types.ts` - Shared Types

All shared types are defined here. Both the service worker and the app page import from this file.

```typescript
type SortBy = 'url' | 'title' | 'custom';
type GroupFrom = 'leftToRight' | 'rightToLeft';
type DuplicateTabHandling = 'none' | 'closeAllButOne' | 'group';
type GroupingMode = 'subdomain' | 'domain';

interface SortSettings {
  sortBy: SortBy;
  groupFrom: GroupFrom;
  preserveOrderWithinGroups: boolean;
  groupSuspendedTabs: boolean;
  sortPinnedTabs: boolean;
  duplicateTabHandling: DuplicateTabHandling;
  groupingMode: GroupingMode;
}
```

Session types: `SESSION_SCHEMA_VERSION`, `SessionId`, `SessionKind` (`'saved' | 'history'`), `SessionOrigin`, `TabGroupColor`, `TabSnapshot`, `GroupSnapshot`, `WindowSnapshot`, `WindowBounds`, `Session`, `SessionSummary`, `SessionIndex`, `SessionSettings` + `DEFAULT_SESSION_SETTINGS`, `ExportFormat`, `ExportBundle`. Chrome runtime ids (tab/window/group) are never persisted; groups are referenced by index. `SortSettings` is untouched.

### `src/pages/` - The extension page

`app.tsx` is the container: hash route, session index, open windows, restore, search, dialogs, the notice toasts and the error lines. Views are presentational and take explicit props.

| File                     | What it owns                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/app-route.ts`   | `parseRoute` / `formatRoute` for `#open`, `#settings` (and `#settings/youtube`, a `SettingsFocus` the dialog scrolls to and focuses), `#saved/<id>`, `#auto/<id>`, `#search/<q>`; anything unknown falls back to the open-tabs view. Also `viewBehind`, `RouteState` + `advanceRoute`, and `viewBelow()` (Navigation API) over its pure half `routeOfEntryBelow` |
| `src/hooks/use-route.ts` | `useRoute()`: the hash route kept in step with the address bar and Back; `navigate`, `closeSettings`, `resetPage`                                                                                                                                                                                                                                                |

**Notices are toasts, errors are lines.** A notice ("Exported …", "Saved …", "Setting saved") never takes a line in the layout: a line above the content pushes the pane down when it appears and back up when it goes, which reads as the page shaking. `app.tsx` owns one stack (`useSavedToasts` + `SavedToasts`, queue rules in `src/lib/toast-queue.ts`): `setNotice(message, key?)` shows a plain 4 s toast (`NOTICE_MS`), `onSaved` the 1 s ticked one, and toasts sharing a `key` are one toast that is rewritten in place (the "Export everything" count and its final line). Errors and the quota notice stay inline because they must remain until dealt with.

**Settings is a dialog with an address.** `#settings` is still a route (Chrome's "Options" opens it, a middle-click opens it in its own tab), but `app.tsx` draws it as a shadcn `Dialog` over the view you were in: `useRoute()` (`src/hooks/use-route.ts`) returns both `route` (the address) and `page` (what the panes show - `viewBehind(route, previous)` in `app-route.ts`, i.e. the last non-settings view, the open tabs after a direct load). The view behind is read from the history entry below through the Navigation API (`viewBelow()` in `src/lib/app-route.ts`), so it is still right after a reload or a typed `#settings`: when there is such an entry, closing (Escape, ×, click outside) is `history.back()` and leaves no dead Back press; when Settings is the first thing the tab showed (direct load), the entry is replaced by the open-tabs view instead. Focus returns to whatever opened it, the restore `ProgressToast` moves inside the dialog while it is open, and closing blurs the focused field first so a write-on-blur input is not lost. The error lines and the toast stack render inside the dialog while it is open. `SettingsView` must be rendered inside a `DialogContent`; its width and scrolling body are classes passed from `app.tsx`, never edits to `src/components/ui/dialog.tsx`.
| `src/lib/open-saved-tab.ts` | Clicking a saved tab: jump to that exact URL if it is already open, otherwise open it in the background |
| `src/components/sidebar-nav.tsx` | The left column; snapshots folded away, the recovered one badged |
| `src/pages/open-tabs-view.tsx` | Live windows + the Save button (label follows the window count); the tab selection (see below); and, with more than one window open, **Assemble!** - `app.tsx` calls `assembleTabs()` from `src/lib/assemble-tabs.ts` in the page (it is only `chrome.*` calls; the target is the last-focused window, i.e. this one) and words the result with `assembleOutcome()` in `src/lib/assemble-notice.ts` |
| `src/pages/session-detail.tsx` | Rename (click the title), Open / Open in this window, per-window and per-tab actions, export, delete |
| `src/pages/snapshot-detail.tsx` | Open, **Keep** (`duplicateAsSaved` + `remove` - a move), delete |
| `src/pages/settings-view.tsx` | The content of the Settings dialog: the language menu on the title row, left of the × (Automatic, then each language in its own name; a choice is stored, then the page reloads into it - `#settings` brings the dialog back); Sorting (Sort by + Duplicate tabs; Tab groups, Grouping direction and Preserve order indented under Sort by only while it is Custom; Sort pinned tabs and Group suspended tabs under Advanced), YouTube (`YoutubeAccessField`: "Access to YouTube" with Allow access / Remove access, the state read through `useYoutubeAccess()`; its own section right after Sorting and never under Advanced, because the menu item sends people here to grant it: `#settings/youtube` scrolls to the row, focuses Allow access and says why), Sessions, Backup, Keyboard shortcuts. Every control writes immediately; every dropdown is `src/components/select-menu.tsx` (shadcn Select, the list opening just below the control); an `Advanced` fold shows a grey description of what it holds |

**Selecting open tabs.** Only the Open tabs list has tick boxes (`TabRow`'s optional `selection` prop, threaded through `GroupSection` → `WindowTree` → `OpenWindowsPane`; saved sessions, snapshots and search results pass nothing and render exactly as before). A click on the row still goes to the tab - only the box selects, shift-click takes the range from the box ticked last. Each open window also gets a row between its header and its tabs (`WindowSelectAll`, passed to `WindowTree` as `subheader`, which nothing else passes) holding one tri-state **Select all** box, lined up with the rows' boxes: ticked when every tab of the window is selected, a dash when some are, empty when none; clicking it ticks the whole window (collapsed groups and tabs past "show more" included) or, when all are ticked, clears it, leaving other windows' ticks alone (`selectionState()` / `toggleWindow()` in `src/lib/tab-selection.ts`). There is no page-wide select-all. `OpenTabsView` holds the selection (a set of runtime tab ids, component state only, pruned whenever the live list changes) and, while it is not empty, draws `SelectionBar` **in place of** its heading - same height, so the list does not jump - sticky under the page header (`--app-header-h`, measured in `app.tsx`). Closing more than one tab asks first (`CloseTabsDialog`): a range, a window's select-all or a by-site selection also ticks tabs the list is not showing (collapsed groups, pages past "show more"). Save goes through the app's one `save()` with `captureSession({ tabIds })` (the chosen tabs keep their windows); Copy / Close / "Save & close" (closes only after the save is stored) / "Select all tabs like this · not like this" (same site) are decided in `src/lib/tab-selection.ts` and `closeTabs()` in `window-actions.ts`, both with tests.

Sort settings keep their parsing/validation in `src/lib/sort-settings.ts` (`parseSortSettings`, `SORT_SETTING_KEYS`, the dropdown option lists `sortByOptions()` / `duplicateTabOptions()` / `groupingModeOptions()` / `groupFromOptions()` (functions, because their labels are read with `t()` when drawn), and `showsCustomSortOptions(sortBy)`: the settings only `sortByCustom()` reads are hidden rather than disabled for the other modes) with tests; `SettingsView` stays a thin component. Adding a sort setting means adding it there, to `SORT_SETTING_KEYS` and to the Settings view: under Sort by if only Custom sorting uses it, visible if it changes what a click does, Advanced otherwise.

Keyboard shortcuts are shown through `src/lib/command-rows.ts` (`commandRows(commands, isMac)`: every row has a name and either keys or "Not set", plus a grey hint when a `DEFAULT_SHORTCUTS` suggestion exists but Chrome has not assigned it, which is what an existing install sees after an update adds a `suggested_key`) and `src/lib/shortcut-keys.ts` (turns Chrome's Mac glyphs `⌥⇧S` and `Alt+Shift+S` strings into named keys for this platform).

### `vite.config.ts` - Build & Manifest

The Chrome extension manifest is **defined inline** in `vite.config.ts` using `@crxjs/vite-plugin`'s `defineManifest()`. There is no separate `manifest.json` file. When modifying extension metadata, permissions, or entry points, edit this file.

Permissions: `tabs`, `tabGroups`, `storage`, `contextMenus`, `unlimitedStorage`, `favicon`, `alarms`, `scripting`; `optional_host_permissions: [...YOUTUBE_ORIGINS]` (`https://*.youtube.com/*`, from `src/constants.ts`). `minimum_chrome_version: '123'` (promise-form `contextMenus.removeAll()` is awaited unguarded; `favicon` needs 104; `storage.local.getKeys()` (130) is behind a `typeof` guard so it does not raise the floor). Commands: `_execute_action`, `save-session`, `open-dashboard`, `assemble-tabs`, `pause-youtube` - `save-session` and `open-dashboard` ship without `suggested_key`; `_execute_action` suggests `Alt+Shift+S`, `assemble-tabs` `Alt+Shift+A` and `pause-youtube` `Alt+Shift+P` - all read from `DEFAULT_SHORTCUTS` in `src/constants.ts`, the one place to change a default key (Option+Shift+S / A / P on a Mac; Chrome accepts at most four suggested keys; Chrome drops it silently if another extension holds the key, so the UI shows what `chrome.commands.getAll()` reports rather than promising it). `_execute_action` is Chrome's built-in command for the toolbar icon: a key bound to it fires `action.onClicked` exactly as a click does, so the shortcut sorts through the same two listeners with no second code path. Chrome gives it no description (and calls it "Activate the extension" on its shortcuts page); `commandRows()` in `src/lib/command-rows.ts` names it for Settings. `src/app.html` is registered via `build.rollupOptions.input` (Vite's `root` is `src/`, with `publicDir` = `public/` and `build.outDir` = `dist/` at the repository root, so the page still builds to `dist/app.html` and the extension URL is `app.html`; `test.root` stays the repository root, and a CLI `--outDir` is relative to `src/`) because crxjs only auto-builds manifest-referenced pages and `options_page` carries a `#settings` fragment. `defineConfig` comes from `vitest/config` so `test.setupFiles: ['src/tests/setup.ts']` applies.

---

## Tech Stack

| Category         | Tool                                                                 |
| ---------------- | -------------------------------------------------------------------- |
| Language         | TypeScript (strict mode, ESNext target)                              |
| UI Framework     | React 19                                                             |
| CSS              | Tailwind CSS 4                                                       |
| UI Components    | shadcn/ui (Radix UI + CVA)                                           |
| Build            | Vite 8 + @crxjs/vite-plugin                                          |
| Linter/Formatter | oxlint + oxfmt (every file type oxfmt supports)                      |
| Git Hooks        | Lefthook                                                             |
| Testing          | Vitest (unit) + `scripts/e2e/smoke.ts` (real Chrome, via Playwright) |
| Release          | release-it (GitHub release + ZIP via `scripts/zip.ts`)               |
| CI               | GitHub Actions (tool versions from `mise.toml`) + Dependabot         |
| Tool Versions    | mise                                                                 |

---

## Development Commands

```bash
pnpm dev              # Start Vite dev server (port 5173)
pnpm build            # Vite build -> dist/ (no type check; run typecheck separately)
pnpm typecheck        # Type check only (tsc --noEmit, then -p src/tests)
pnpm format           # oxfmt --write over the whole repository
pnpm format:check     # oxfmt --check (what CI runs)
pnpm lint             # oxlint --deny-warnings
pnpm lint:fix         # oxlint --fix
pnpm test             # Run tests (vitest)
pnpm release          # release-it: regenerate CWS assets, bump version, build, ZIP, GitHub release

pnpm exec tsx scripts/e2e/smoke.ts   # Real-Chrome sessions smoke test (run `pnpm build` first)
pnpm e2e:assemble                    # e2e build (in node_modules/.cache) + real-Chrome assemble-tabs checks
pnpm e2e:sort                        # Real-Chrome sort checks against dist/ (run `pnpm build` first; headed)
pnpm e2e:selection                   # Real-Chrome checks of the Open tabs selection (run `pnpm build` first; headed)
pnpm exec tsx scripts/zip.ts        # Package the current dist/ into release/Tabinet-<version>.zip

pnpm site:dev                        # The project website on a local dev server (http://localhost:4321/tabinet/)
pnpm site:build                      # astro check + astro build -> site/dist/

pnpm server:typecheck                # tsc over server/ (the sync server)
pnpm server:test                     # the sync server's vitest (PGlite, no network)
```

### Local Development Workflow

1. `pnpm install`
2. `pnpm dev`
3. Open `chrome://extensions`, enable Developer mode
4. Click "Load unpacked" and select the `dist/` folder
5. The extension auto-reloads on code changes via CRX plugin HMR

---

## Code Style & Conventions

### Enforced by oxfmt (`.oxfmtrc.json`) and oxlint (`.oxlintrc.json`)

- **Scope**: every file oxfmt can format: TS/TSX/JS, JSON, Markdown, YAML, TOML, CSS and HTML (`scripts/promo-template.html` included; its `{{PLACEHOLDER}}`s survive). Only generated output is left out: `dist`, `release`, `assets`, `pnpm-lock.yaml`, `site/.astro`, plus whatever `.gitignore` lists
- **Indent**: 2 spaces
- **Line width**: 100 characters
- **Line endings**: LF
- **Quotes**: Single quotes for JS/TS, double quotes for JSX
- **Semicolons**: Always
- **Trailing commas**: Always
- **Imports**: sorted by oxfmt (`sortImports`)
- **No em or en dashes** (set by the owner): never write U+2014 or U+2013 anywhere in the repository, in code, comments, docs, UI text, commit messages or PR text; use a plain hyphen-minus (`-`). `scripts/check-dashes.ts` (`pnpm check:dashes`, part of `pnpm lint` and the pre-commit hook) fails on any tracked file that has one
- **Block statements**: Required (oxlint `curly: all`)
- **Lint rules**: oxlint's correctness category as errors, plus `react/no-array-index-key`, `react/no-danger`, `jsx-a11y/prefer-tag-over-role` and `jsx-a11y/no-noninteractive-element-to-interactive-role`. The React Compiler rules (`react/set-state-in-effect`, `react/refs`, `react/purity`) are off: the app is not compiled with it. A deliberate exception is an `oxlint-disable-next-line <rule> -- <reason>` comment on the line above, always with the reason

### TypeScript

- Strict mode enabled
- Path alias: `@/*` maps to `./src/*`
- No `any` types - use proper type narrowing (see the type guards in `src/lib/import-guards.ts` and `src/lib/sort-settings.ts`)
- Chrome API types from `@types/chrome`

### Git Conventions

- **Every change goes issue → pull request → merge (set by the owner).** Code, docs, config, CI, screenshots and version bumps alike: open a GitHub issue first, do the work on a branch (`<type>/<short-name>`, e.g. `feat/store-i18n`), open a pull request whose body says `Fixes #<issue>`, and merge it (squash) into `main` only once the required `ci` check is green. Never commit or push to `main` directly, not even a one-line fix. Independent issues may run in parallel on separate branches; dependent ones merge in order. The only thing pushed outside a pull request is a release tag (see Release procedure)
- **Keep this checkout in step with upstream (set by the owner).** Whenever work happens anywhere but this checkout (a worktree, a clone in the scratchpad), once its pull request is merged bring this checkout back too: `git checkout main && git pull` here, then `git worktree prune`. The owner reads the code in this folder, so a merged change must be visible here, not only on GitHub
- **Commit format**: Conventional commits (`feat:`, `fix:`, `chore:`, `refactor:`)
- **DO NOT** add `Co-Authored-By` lines to commit messages
- **Pre-commit hook**: gitleaks on the staged changes first (a secret stops the commit; `.gitleaks.toml`), then oxfmt on the staged files (re-staged when fixed), then oxlint on the staged JS/TS files
- **Pre-push hook** (parallel): `pnpm typecheck`, `pnpm test`, `pnpm build`, and an `update-docs` step that, when `src/**`, `scripts/**`, `package.json`, or `vite.config.ts` changed in the last commit, runs `claude -p` to refresh `AGENTS.md`/`README.md` and amends the commit

### Component Patterns

- UI components use shadcn/ui conventions: `cn()` for class merging, CVA for variants
- Stock components are in `src/components/ui/` and are generated via `shadcn` CLI
- Hand-made components are in `src/components/` (flat) and screens in `src/pages/`; `src/components/ui/` is for stock shadcn components only

---

## Chrome Extension Specifics

### Manifest V3

The manifest is generated at build time from `vite.config.ts`. Key points:

- **Service Worker**: `src/service-worker.ts` (module type), the only module the manifest names for the worker
- **One page**: `app.html` (`build.rollupOptions.input`), opened only through `openDashboard()`, so there is only ever one app tab. It is the only HTML page; Chrome's "Options" opens `app.html#settings` directly.
- **Options Page**: `options_page: 'app.html#settings'` (not `options_ui` - full-page, not embedded). A fragment in `options_page` is accepted; verified in Chrome for Testing 151.
- **No popup**: Extension icon click triggers sorting directly. `action.default_title` is the tooltip that tells a first-time user about the right-click menu.
- **No content scripts**: All operations use Chrome APIs only
- **Commands**: `_execute_action` (sort - the icon click), `save-session`, `open-dashboard`, `assemble-tabs`, `pause-youtube` - sorting suggests `Alt+Shift+S`, assembling `Alt+Shift+A` and pausing YouTube `Alt+Shift+P`; the other two are unbound by default (users assign keys at `chrome://extensions/shortcuts`).
- **Minimum Chrome**: `minimum_chrome_version: '123'`. Raise it only for an API used without a runtime guard, and say why in the `vite.config.ts` comment.

### Permissions Explained

| Permission                                | Why                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tabs`                                    | Read tab URLs and titles for sorting and session capture; create/discard tabs on restore; move tabs between windows (`assemble-tabs`)                                                                                                                                                                            |
| `tabGroups`                               | Create, move, and update tab groups; recreate groups on restore; move whole groups between windows (`assemble-tabs`)                                                                                                                                                                                             |
| `storage`                                 | `chrome.storage.sync` for `SortSettings`; `chrome.storage.local` for sessions, index, session settings                                                                                                                                                                                                           |
| `contextMenus`                            | "Assemble!", "Save all windows as session" and "Pause all YouTube videos" on the action icon (`contexts: ['action']`); opening the page is Chrome's own "Options" entry                                                                                                                                          |
| `unlimitedStorage`                        | Sessions with thousands of tabs exceed the 10 MB local quota; raises the local quota only, uploads nothing                                                                                                                                                                                                       |
| `favicon`                                 | `chrome-extension://<id>/_favicon/?pageUrl=…` on the app page, from Chrome's local cache - zero network                                                                                                                                                                                                          |
| `alarms`                                  | Timer for automatic history snapshots (`history-snapshot` periodic + one-shot `history-first`; none while `historyEnabled` is false) and cloud sync (`cloud-sync` every 15 min + one-shot `cloud-sync-soon`; none while signed out)                                                                              |
| `scripting`                               | `chrome.scripting.executeScript({ func: pauseVideosInPage })` into YouTube tabs for "Pause all YouTube videos"; works only where the optional host permission below is granted                                                                                                                                   |
| `identity`                                | Cloud sync sign-in only: `chrome.identity.getAuthToken({ interactive: true })` with the manifest's `oauth2` (`openid`, `email`), called from the Sign in with Google click in Settings > Account; never at load, never without that click. Added by `...cloudSyncPermissions()` while `CLOUD_SYNC` is configured |
| `https://*.youtube.com/*` (optional host) | Granted by the person with "Allow access" in Settings (never at install), removable there; lets the pause run on youtube.com, www, m and music. Reads nothing from the page                                                                                                                                      |

No `host_permissions` (only the one optional host permission above, asked for at run time), no `content_scripts` (pausing YouTube is programmatic injection of one packaged function, no remote code), no `downloads` (export uses a Blob URL + `<a download>` in the page), no `default_popup`, no `side_panel`. Every permission change must be mirrored in the same PR in `PERMISSION_JUSTIFICATIONS` in `scripts/store-listing.ts` (its test fails until it matches the manifest; an optional host permission goes to `OPTIONAL_HOST_PERMISSION_JUSTIFICATIONS`, also tested, and to `HOST_PERMISSIONS_AND_REMOTE_CODE`), `PRIVACY_POLICY.md` (Permissions + Last Updated), `README.md` (Privacy bullet) and this table.

### Storage Schema

**`chrome.storage.sync`** - `SortSettings` (defaults `DEFAULT_SORT_SETTINGS` in `src/lib/sort-settings.ts`), and `uiLanguage` (`'auto' | SupportedLocale`, default `'auto'`, anything else reads as `'auto'`; `src/lib/ui-language.ts`, never part of `SortSettings` / `SORT_SETTING_KEYS`). A `tabSuspenderExtensionId` key an older version stored there is no longer read or written (suspended tabs are recognised by shape, see `src/lib/suspended-url.ts`); it is left in place, never deleted. Sessions code never touches `chrome.storage.sync`: not the sessions modules of `src/lib/`, nor `src/hooks/`, `src/components/` or `src/pages/` (`sort-tabs.ts`, the Settings view's sort settings and `ui-language.ts` are the only sync access). Session data and `sessionSettings` must never go to sync (100 KB total, 8 KB per item, write-rate limits).

**`chrome.storage.local`** - session data, one key per record, never one big array:

| Key               | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session:<uuid>`  | `Session` body (windows → groups/tabs)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `sessionIndex`    | `SessionIndex` - `SessionSummary[]` newest-first by `updatedAt`, authoritative key list                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `sessionSettings` | `SessionSettings` (device-local; defaults `DEFAULT_SESSION_SETTINGS` in `src/types.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `historyMeta`     | `{ lastHash, lastSnapshotAt }` - dedupe baseline for `takeHistorySnapshot()`; removed again when the snapshot it fingerprints is deleted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `cloudAccount`    | `CloudAccount` `{ token, expiresAt, email }` - the signed-in cloud sync account (`src/lib/cloud-auth.ts`); absent while signed out                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `cloudSyncKey`    | The raw AES-GCM sync key, base64, unlocked from the sync passphrase. Never sent anywhere; removed on sign-out and on Delete cloud data                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `cloudSyncMeta`   | Cloud sync bookkeeping (`src/lib/cloud-sync-state.ts`, the only writer, always under the sessions lock): `owner` (informational) / `keyId`, `cursor`, `lastSyncAt`, `lastError`, `dirtySessions` / `deletedSessions` (id to `updatedAt` / deletion time), `knownVersions` (id to the newest `updatedAt` this device applied, deleted or had accepted, kept for good: a remote live record at or below it is refused when there is no local copy, so a replayed old record cannot resurrect a deleted session), `settingsUpdatedAt`, `settingsDirty`, `settingsHash` / `settingsSyncedAt`, `pendingSettings` (received settings not yet fully written). Kept on sign-out, expiry and a 401 (changes are still recorded and sent after signing in again with the same key); it is bound to `keyId` alone, never to the email the untrusted server reports, so only another key (another account, or a passphrase made again) starts it afresh |

Write order is body → index (put) and body → index (delete). `sessionRepo.reconcile()` (app-page mount, `onInstalled`, `onStartup`) re-indexes orphan `session:*` bodies via `chrome.storage.local.getKeys()` (guarded fallback to `get(null)`), drops index entries without a body, and re-derives an entry that no longer matches its body. It is the **repair** path, so it is the one reader that tolerates an unreadable index: it treats it as empty and rebuilds it from the bodies. Every mutation still rejects on a future-schema index - this build must not overwrite a store a newer one wrote. A future-schema _body_ is kept and flagged instead of dropped (`SessionSummary.unreadable`), so a downgrade shows an inert "saved by a newer version" row the user can delete rather than an empty list. `sessionRepo.removeAll()` ("Delete all session data" in the dashboard's `StorageMeter`) removes every `session:*` body, `sessionIndex` and `historyMeta` under the lock; `sessionSettings` survives. `chrome.storage.local.getBytesInUse()` feeds the meter.

**`sessionStorage`** (the app tab only) - `src/lib/ui-state.ts` keeps one per-tab UI flag there (`tab-organizer:history-open`). Not user data, never `chrome.storage`, never through `sessionRepo`; both accessors are guarded because `sessionStorage` is absent under vitest and throws when the browser blocks site data.

### Sessions rules (do not break)

- **Single write path.** Every write to session keys goes through `sessionRepo` in `src/lib/session-repo.ts`, which serializes with `withLock()` (`navigator.locks.request('tab-organizer:sessions', …)`, shared by the service worker and both extension pages; promise-chain fallback when Web Locks are unavailable). Never call `chrome.storage.local.set/remove` for session keys anywhere else.
- **Never add tab listeners to the service worker.** No `chrome.tabs.on*`, `chrome.windows.on*`, `chrome.tabGroups.on*` in `src/service-worker.ts`, or in any module it imports at load time - ever. History uses `chrome.alarms` only; the dashboard's live open-windows pane registers its listeners inside the page (`useOpenWindows`), where they die with the tab. Every worker listener is registered synchronously at module top level of `src/service-worker.ts` - never inside an async callback or after an `await`.
- **Sessions code never touches `chrome.storage.sync`** - no read, no write. The one exception is cloud sync's settings path in `src/lib/cloud-sync.ts` (`readLocalSettings()` and the apply step of `applySettingsRecord()`), which reads and writes the sort settings and `uiLanguage` there because that is where they live; nothing else in sessions code may. Suspended tabs are recognised by the shape of their url (`src/lib/suspended-url.ts`), not by a stored id. Session data and session settings live in `chrome.storage.local` only.
- **The icon click stays `sortTabGroups()` only.** No `default_popup`, no dialogs, no `openDashboard()` on `action.onClicked`. `sort-order.ts` and the duplicate handlers are not edited by session work.
- **Restore runs in the app page**, never in the worker. Own extension pages are excluded from every capture.
- **No Chrome runtime ids in stored data** - groups are referenced by `groupIndex`; pinned tabs never carry `groupIndex`; at most one `active` tab per window.
- **A chrome namespace touched at module-evaluation time needs its permission in the same commit.** Anything `src/service-worker.ts` (or any module it imports) reads or calls while the module body runs, such as `chrome.alarms.onAlarm.addListener(…)`, `chrome.something.CONSTANT` or a top-level `chrome.x.y()`, runs while the one worker module evaluates, and the imported modules' bodies run before the worker's own. A missing permission makes that line throw, the whole service-worker module fails to evaluate, and every listener after it is never registered: the sorting `chrome.action.onClicked` sits near the end of the file, so **tab sorting dies too** - a permission typo takes out the unrelated core feature, not just sessions. So add the permission to `vite.config.ts` in the very same commit as the code that touches the namespace (never "wire it up now, add the permission later"). `alarms` is the live example: `chrome.alarms.onAlarm.addListener` in `src/service-worker.ts` and `'alarms'` in `permissions` landed together and must stay together.

## Cloud sync (on, opt-in per person)

Cloud sync, in three stages: the server (issue #165), sign-in, the sync passphrase and the API client (#166), and the sync engine (#170) that moves saved sessions and the settings. It ships switched on (issue #178), and stays opt-in for each person: nothing is sent until they press Sign in with Google in Settings > Account. `CLOUD_SYNC = { apiBase, googleClientId }` in `src/constants.ts` names the deployed server (`apiBase: 'https://tabinet-server.vercel.app'`: Vercel functions in Singapore `sin1`, Postgres on Neon in `aws-ap-southeast-1`) and the Google OAuth client (type "Chrome extension", bound to the store item id); `cloudSyncConfigured()` is true only when both are set, so `cloudSyncPermissions()` is `['identity']` and `cloudSyncOauth2()` gives the `oauth2` key, `vite.config.ts` spreads both into the manifest, and `SettingsView` shows the Account section. Clearing `apiBase` makes a build dormant again: no `identity`, no `oauth2`, no Account section, and every entry point below returns at once. The OAuth client is bound to the store item id `bmbpmnfhfbdjdjpblimidmbohgccmjdg` and the manifest carries no `key`, so an unpacked build (`pnpm dev`, a local `dist/`, the e2e harness) has another extension id and `getAuthToken` refuses the client there: sign-in works only in the store build. To test it locally, either load a build whose manifest has the store item's public `key` (Developer Dashboard, Package, "View public key"; ask the owner before committing it), or create a second "Chrome extension" OAuth client for the unpacked id, use it as `googleClientId` in that build only and add it to the server's `GOOGLE_CLIENT_IDS`. Once configured, the manifest carries `oauth2: { client_id, scopes: ['openid', 'email'] }` (`GOOGLE_OAUTH_SCOPES`), which `chrome.identity.getAuthToken` reads. Running code reads the config through `cloudSyncConfig()` / `isCloudSyncEnabled()` in `src/lib/cloud-config.ts`; tests point it at a fake server with `overrideCloudSyncConfig(getter)` (or switch it off with an empty `apiBase`, which the dormancy tests do explicitly, since the shipped constant is configured) and back with `overrideCloudSyncConfig()`. `identity` is justified in `PERMISSION_JUSTIFICATIONS` in `scripts/store-listing.ts` (its test reads the literal `permissions` array and adds what `...cloudSyncPermissions()` contributes), and `PRIVACY_POLICY.md` (section "Cloud sync"), its translations, the store text (Data usage, data types, Descriptions, Test instructions), the website copy and README describe what sync sends; change them together with any change to what is synced or where the server runs.

- `src/lib/cloud-crypto.ts` (WebCrypto only): `createKeySetup(passphrase)` → `{ setup, rawKey }` (PBKDF2-SHA-256, 600000 rounds, 16-byte salt, AES-GCM 256; `check` is `tabinet-key-check-v1` encrypted under a 12-byte `checkIv`; all base64), `unlockKeySetup(setup, passphrase)` → `rawKey` or `null`, `keyMatchesSetup(rawKey, setup)` (the check text decrypts under the key), `base64ByteLength()` and the bounds the server enforces (`KDF_MIN_ITERATIONS`..`KDF_MAX_ITERATIONS` = 100000..10000000 rounds, `SALT_MIN_BYTES`..`SALT_MAX_BYTES` = 16..64), `encryptRecord(rawKey, meta, value)` / `decryptRecord(rawKey, meta, payload)` (throws `CloudDecryptError`, an `ExplainedError`). `meta` is the record's `{ kind, id, updatedAt, deleted }`, bound to the ciphertext as AES-GCM additional data (`recordAdditionalData()`: the UTF-8 line `tabinet-record-v1|<kind>|<id>|<updatedAt>|<0 or 1>`), so a ciphertext the server moves to another kind or id, replays under another `updatedAt` or flips to or from a tombstone does not decrypt. The key check is encrypted without additional data, unchanged.
- `src/lib/cloud-api.ts`: one function per route (`authGoogle`, `logout`, `me`, `putKeys` → `'created' | 'exists'`, `getRecords`, `postRecords`, `deleteAccount`), `fetch` injectable, every answer checked by hand. `isCloudKeySetup` refuses a setup outside the server's own bounds (rounds, salt length, 12-byte `checkIv`, real base64), so a bad answer is `errorCloudBadResponse` and never reaches PBKDF2. A 401 is `CloudUnauthorizedError`, except on `POST /v1/auth/google` (no token sent), where it means the Google access token was refused and is `errorCloudSignInFailed`; other statuses and network failures are `ExplainedError`s (`errorCloudUnreachable`, `errorCloudServer`, `errorCloudRejected`, `errorCloudBadResponse`) that `error-message.ts` explains. Tokens and ciphertext never go into an error message or a log.
- `src/lib/cloud-auth.ts` (page only): `signIn()` straight from a click (`chrome.identity.getAuthToken({ interactive: true, scopes })`, promise form resolving to `{ token }`; the Google access token goes once to `authGoogle` as `{ accessToken }` and is then dropped from Chrome's cache with `removeCachedAuthToken`, success or failure, and never stored; a closed or refused consent window is `'cancelled'`, decided by the pure `isSignInCancelled(err)` on Chrome's "did not approve" wording or an explicit cancel, anything else is `errorCloudSignInFailed`), `signOut()` (best-effort logout, then forget `cloudAccount` + `cloudSyncKey`, then `clearAllCachedAuthTokens()` behind a `typeof` guard so the next sign-in asks again), `deleteCloudData()` (the same after a successful deletion), `setUpPassphrase()` (→ `{ outcome: 'ready', setup } | { outcome: 'exists' }`), `unlockWithPassphrase()` (both store the key only if the account they started with is still the stored one), `withCloudAccount()` (a 401 forgets the account), `loadLiveCloudAccount(now)` (an expired account is forgotten with its key), `keepSyncKeyFor(setup)` (the key stays only when it opens the account's server setup: run by `signIn()` before storing the new account and by every hook read, so a key never carries over to another account or a re-created passphrase), and the pure `accountState()` ('ready' only with the server setup known and its key here) / `newPassphraseProblem()` (8 characters minimum). Local sessions are never touched.
- Settings > Account: `src/components/account-field.tsx` (+ `delete-cloud-data-dialog.tsx`) over `src/hooks/use-cloud-account.ts`, after the YouTube section, one row per state: Sign in with Google, create a passphrase (typed twice, with the warning that it cannot be recovered), enter the passphrase, or ready (email, the last sync time and error from `useCloudSync()`, Sync now, Sign out, Delete cloud data).
- **The engine** (`src/lib/cloud-sync.ts`, bookkeeping in `src/lib/cloud-sync-state.ts`). Records: a saved session is `{ kind: 'session', id, updatedAt = Session.updatedAt }` with the whole body encrypted (`encryptRecord`); a deleted one is a tombstone (`deleted: true`, `updatedAt` = when it was deleted, `{ deleted: true }` encrypted inside like any record, so the server cannot forge one); the settings are one `{ kind: 'settings', id: 'settings' }` record holding `{ sort, sessionSettings, uiLanguage }`. Last writer wins by `updatedAt`, as on the server. Snapshots (`kind: 'history'`) never sync; Keep makes a saved session, which does.
  - `syncNow({ fetch?, pageSize? })` → `{ outcome: 'synced' | 'notReady' | 'failed', pulled, pushed }`, under its own Web Lock `tabinet:cloud-sync` (page and worker never sync at once); network calls run outside the sessions lock. The first run for a key (`keyId` in `cloudSyncMeta`) marks every saved session and the settings dirty. **Pull:** `GET records?since=cursor` until `hasMore` is false, the cursor stored after each page; a session newer than the local copy goes through `sessionRepo.applyRemote()`, a newer tombstone deletes the local copy, newer settings are applied: first recorded in the bookkeeping with the settings themselves as `pendingSettings`, then `sessionSettings` through `sessionRepo.setSettings()`, then the sort settings and `uiLanguage` to `chrome.storage.sync` last (a new language reloads the app page as soon as it lands), then `pendingSettings` is cleared (`writeReceivedSettings()`). A run cut short in between leaves them pending; the next sync writes them again before it pulls, and meanwhile no local settings change is taken for an edit, so a half-applied mix is never pushed. Every record is decrypted against its metadata before anything else, a tombstone included (one with an empty or forged ciphertext never deletes anything); a record that does not decrypt, or whose content contradicts its metadata (a tombstone not holding `{ deleted: true }`, a session whose id or `updatedAt` differs, settings under another id or as a tombstone), is skipped and named in `lastError`; it never deletes or changes local data. The server is untrusted: it can withhold records, but not read, forge, move, roll back or resurrect one. **Push:** the dirty records, encrypted, in batches of at most 100 records and 3.5 MiB (`splitIntoBatches`); a session over the server's 1 MiB ciphertext stays local (`errorCloudRecordTooLarge`). `applied` clears the entry only if it was not changed again meanwhile; `stale` applies the server's `current` (ties go to the server, except a live record against a deletion or `knownVersions`) and so clears it; a `current` of another kind or id settles nothing, and one that does not decrypt never drops a pending deletion. Then `lastSyncAt` and `lastError` (`errorMessage()`, in the UI language). A network failure leaves the dirty sets as they are; a 401 forgets the account (#166) but keeps the bookkeeping. A run that finds the device not ready (a token that expired quietly) clears the sync alarms through `ensureSyncAlarm()`.
  - **Change tracking** (while configured, once the first sync started the bookkeeping; it goes on while the device is not ready, signed out or expired, so the next sign-in to the same account and key sends those changes, deletions included): `sessionRepo`'s saved-session writes (`put`, `rename`, `update`, `remove`, `removeAll`, `duplicateAsSaved`) call `trackSessionChanges()` inside their own lock, so a change lands in `dirtySessions` and a deletion in `deletedSessions` (stamped after the session's own `updatedAt`). `sessionRepo.applyRemote()` decides last-writer-wins under the lock and is never tracked; it never overwrites or deletes a snapshot or an unreadable body. With cloud sync configured, `rename` and `update` of a saved session move `updatedAt` forward (`stampEdit`: now, and always past the old value); unconfigured they keep it, as before. Settings: `noteSettingsChange()` compares a fingerprint of the current settings with the one last exchanged with the server (`settingsHash`): different is dirty and stamped now, equal is clean; nothing is marked while `pendingSettings` is set (a sync soon finishes the apply instead). Being state-based, applying the server's settings cannot echo back.
  - **Triggers** (`src/service-worker.ts`, all registered at module top level; no new permission): the periodic `cloud-sync` alarm (every 15 minutes) is armed by `ensureSyncAlarm()` in `onInstalled` / `onStartup` and whenever `cloudAccount` / `cloudSyncKey` change to a ready state, and cleared when they no longer are (the bookkeeping stays); the one-shot `cloud-sync-soon` alarm (`scheduleSoonSync()`, 1 minute, never pushed back) follows new work in `cloudSyncMeta` or a settings change, both seen by `handleCloudStorageChange()`, which the worker's `storage.onChanged` calls first. Either alarm runs `syncNow()`. The app page runs one sync when it opens, and Settings > Account has Sync now. Every entry point returns at once while `CLOUD_SYNC` is empty: no storage read, no alarm, no fetch.
- Tests: `cloud-sync.test.ts` runs two (or three) simulated devices, each with its own chrome fake, against `fakeSyncServer()` in `src/tests/cloud-fetch.ts` (real last-writer-wins, `seq`, `since` paging, tombstones and limits): create / edit / delete either way, concurrent edits, edit against delete, offline and back, a stale push answered with `current`, snapshots never uploaded, Keep, a settings round trip without an echo, an undecryptable record skipped, a hostile server (forged or empty tombstone, a ciphertext replayed under a newer `updatedAt` for a session and the settings, moved to another id or kind, the deleted flag flipped, a forged stale `current`: each changes nothing and reports `errorCloudDecrypt`), batches by count and size, paging and the stored cursor. `cloud-sync-state.test.ts` covers the dirty tracking hooks in `sessionRepo`, `applyRemote`, the alarms, dormancy and the pure helpers; `service-worker-sync.test.ts` the worker wiring. `cloud-crypto`, `cloud-api` and `cloud-auth` in `src/tests/`, with `src/tests/cloud-fetch.ts` standing in for the server and the fake's `chrome.identity` (`getAuthToken` answered by `state.authTokenAnswer` - a token, an `Error`, or a function of the request - and recorded in `state.authTokenRequests`; `removeCachedAuthToken` recorded in `state.removedAuthTokens`; `clearAllCachedAuthTokens` counted in `state.authTokenCacheClears`).

## Internationalization

The extension speaks English (`en`, the manifest's `default_locale`), Korean (`ko`), Spanish (`es`) and Japanese (`ja`), through Chrome's own `chrome.i18n`. By default ("Automatic") Chrome picks the browser's UI language (`chrome://settings/languages`, "Display Google Chrome in this language"; on macOS the system language order) and uses the closest `_locales` folder (`es-419` reads `es`), falling back to English for a language that is not shipped and, key by key, for a message a language lacks. That is why English must hold every key.

**The language menu in Settings.** A person can override Chrome's choice from the menu on the Settings dialog's title row (Automatic, English, 한국어, Español, 日本語 - endonyms, from `LOCALE_ENDONYMS` in `src/constants.ts`). The choice is `uiLanguage` in `chrome.storage.sync` (`src/lib/ui-language.ts`). `chrome.i18n` cannot be switched at run time, so the override lives in `src/lib/i18n.ts`: `applyUiLanguage(choice, read?)` loads the chosen `_locales/<code>/messages.json` and English (`fetch(chrome.runtime.getURL(...))`, which works in the page and the worker; `read` is injectable, and tests pass `readLocaleFile` from `src/tests/chrome-fake.ts`), and `t()` / `tp()` then fill them in through `formatMessage()` exactly as `chrome.i18n.getMessage` does (named placeholders first, `$1`..`$9`, `$$`, a missing substitution empty, per-key English fallback); `'auto'` goes back to `chrome.i18n`. `uiLocale()` follows on its own, because it reads `localeCode` through `t()`. The app page awaits `applyStoredUiLanguage()` in `src/pages/index.tsx` before the first render; choosing a language writes the setting and reloads the page, so every string, module-level formatter and `Intl` object is rebuilt in it. The menu shows `appliedUiLanguage()` (the choice actually in use: `'auto'` when the chosen catalog failed to load), never a fresh storage read, and a refused write shows `languageSaveFailedMessage(err)` (Chrome's reason only through `knownErrorText()`, else `settingsSaveFailedPlain`). `followUiLanguageChanges()` (registered by `index.tsx`) reloads the page when the stored choice changes to one it is not in, from another window or device (`uiLanguageChangeNeedsReload()`, pure). Each endonym option carries its code as `lang` (`SelectOption.lang` in `src/components/select-menu.tsx`) so a screen reader reads it in that language. The worker starts the read at load and every text-making handler waits on `uiLanguageReady()` (see the service-worker table); a change of the setting re-registers the context menus. Out of reach: the manifest's name, description, `action.default_title` and the command descriptions at chrome://extensions are read by Chrome itself and always follow Chrome's language.

**Where messages live.** `public/_locales/<lang>/messages.json`, copied as it is to the extension root, where Chrome looks. Each entry is `{ "message", "description" }`: the description tells a translator where the text appears, what each `$n` is and any length limit (button, menu item, the 132-character Summary). The manifest refers to messages instead of holding text: `name: '__MSG_extName__'`, `description: '__MSG_extDescription__'`, `action.default_title: '__MSG_actionTitle__'` and each command's description (`__MSG_cmdSaveSession__`, ...), so Chrome, chrome://extensions and the Web Store show them in the user's language.

**Reading them: `src/lib/i18n.ts`.**

- `t(key, ...subs)` is `chrome.i18n.getMessage` with `$1`..`$9` filled in, or the same lookup in the chosen language's catalog (below). `MessageKey` is typed from the English file, so a missing key is a type error.
- `tp(base, count, ...extra)` is a counted phrase: keys `<base>_one` / `<base>_other`, chosen with `Intl.PluralRules` for `uiLocale()`, `_other` as the fallback; `$1` is the count formatted for the language, `$2`.. are `extra`. Korean and Japanese need only `_other`. Spanish rules also return `many` (for a million and up); no Spanish `_many` key is shipped, so those counts read the `_other` form, which is correct Spanish for numerals. A language may add `_many` (or `_few`, ...) keys when its plural rules need them, and the parity test accepts them as long as the English `_other` exists. Every counted phrase goes through `tp()`, never `count === 1 ? ... : ...`.
- `uiLocale()` is the language the text is actually shown in: the `localeCode` message (`en`, `ko`, `es`, `ja`; its description says not to translate it), not `chrome.i18n.getUILanguage()`. For a Chrome language the extension does not ship (French, Portuguese, ...) Chrome falls back to the English messages, so `localeCode` reads `en` and plurals and number formats are English too, matching the text (a French Chrome sees "0 tabs" and "1,234", never "0 tab" or "1 234"). Every `Intl.*` call that formats something a person reads takes `uiLocale()` (`formatNumber(n)`, `new Intl.DateTimeFormat(uiLocale(), ...)`), never `toLocaleString()` without a locale and never an English month name. `src/pages/index.tsx` sets `document.documentElement.lang = uiLocale()` at startup.
- `joinSentences(a, b, ...)` puts complete sentences side by side through `commonSentenceJoin` (`$1 $2`; `$1$2` in Japanese, which puts no space between sentences), and `joinFacts([...])` separates short facts on one line through `commonFactJoin` (`$1 · $2`). Only for whole sentences and independent facts; a sentence is never assembled from fragments (see Message rules).
- `t()` needs `chrome` at run time and the tests switch language, so a module-level constant never holds user text: make it a function or compute it at the call. The service worker may call `t()` inside its handlers (`chrome.i18n` works there).

**Message rules.** Key names are camelCase `[A-Za-z0-9_]` with an area prefix (`settingsSortBy`, `storageDeleteAllTitle`); reuse the shared keys (`extName`, `extDescription`, `actionTitle`, `cmd*`, `assembleName`, `common*` such as `commonLoading`, `commonCopiedLinks_*`, `commonWindowsAndTabs`, `tabCount_*`, `windowCount_*`, `sessionGone`) rather than adding a second key with the same English in the same role. One term per concept per language: the automatic snapshots are "snapshots" everywhere in English (sidebar heading, search group and toggle, Settings, storage hints, notices), 스냅샷 in Korean, instantáneas in Spanish, スナップショット in Japanese; a message that names a setting quotes that setting's own label (`storageSnapshotHint` quotes `settingsKeepLast`); a session name is quoted the same way within a language (“$1” in English, “$1” in Korean, «$1» in Spanish, 「$1」 in Japanese). One key per whole sentence, with substitutions written in the message (`$1`, a literal dollar sign `$$`): never build a sentence by concatenating translated pieces or by putting a translated word into another sentence, because word order differs between languages. No em dash (U+2014) or en dash (U+2013) in any language; write `-`.

**Stock shadcn text.** `src/components/ui/` stays as the CLI wrote it, and its only built-in English is the dialog's × (a screen-reader "Close"): every `DialogContent` passes `showCloseButton={false}` and renders `DialogCloseButton` (`src/components/dialog-close-button.tsx`, same look and place, `aria-label={t('commonClose')}`) as its last child. `DialogFooter`'s optional Close button stays unused.

**Never translated, and why.**

- Storage keys, ids, route names (`#saved/<id>`), CSS classes, data attributes: code reads them back.
- `console.*` text and errors that are only logged: they are for developers and bug reports.
- Error messages thrown by our own code (`new RangeError('No window at index 3')`) and Chrome's own error text: they stay English for the console, and are never shown as they are. `src/lib/error-message.ts` is the one way an error reaches the page: `errorMessage(err)` / `reportError(context, err)` (logs the original, returns the text to show) map what can be explained (`LocalizedError`, whose message was made with `t()`; `ExplainedError`, an English message plus a `userKey`; `UnknownSchemaVersionError`, `MalformedRecordError`, our index `RangeError`s, quota, `NotAllowedError`, Chrome's "cannot be edited", "No tab with id" and bounds errors) to `error*` messages, and everything else to `errorGeneric`. `knownErrorText(err)` returns `undefined` for the rest, so a line that embeds a reason (`expCopyFailed`, `restoreFailedItem`, ...) uses its `*Plain` variant instead of English. `errorDetail(err)` is the original, for `console.*`.
- Machine formats: the CSV header (`CSV_HEADER`) and JSON field names, so a file opens the same everywhere.
- Every token the importer parses back, such as `(pinned)` in text exports and the Netscape HTML structure: an export made in one language must import in another, byte for byte. Only the human-readable parts of Markdown/Text/HTML exports (headings, "Window N" labels) are translated.
- Text already stored: a session or snapshot name is created in the UI language at that moment and then kept as it was saved; switching Chrome's language, or the one chosen in Settings, does not rename it.

**Adding a key.** Add it to `en/messages.json` with a description, then to `ko`, `es` and `ja` with the same `$n` (a language may reorder them); use it through `t()` / `tp()`. **Adding a language.** Add the code to `SUPPORTED_LOCALES` in `src/constants.ts` (the one list: the Settings menu, `src/tests/i18n.test.ts`, `LISTING_LOCALES` in `scripts/store-listing.ts`, the scripts and the website's languages in `site/` all derive from it) and add `public/_locales/<code>/messages.json` with every English key. The type checker then names what still lacks it: its endonym in `LOCALE_ENDONYMS` (`src/constants.ts`), its English name in `LOCALE_NAMES` (`scripts/store-listing.ts`), `POSIX_LOCALES` in `scripts/e2e/browser.ts`, `FIXTURE_TEXT` in `scripts/prepare-registration.ts`, and the site's `OG_LOCALES` and copy (`site/src/i18n/`, plus `site/src/privacy/<code>.md`). Then add its Description to `STORE_DESCRIPTIONS` in `scripts/store-listing.ts`, and add it to README's language list.

**What guards it.** `src/tests/i18n.test.ts`: exactly the shipped folders; every language has every English key and nothing else (plural forms aside), the same `$n`, no empty message, no long dash; every English entry has a description and a Chrome-valid name; every `_one`/`_many` has its `_other`; every file's `localeCode` names its own language. `src/tests/chrome-fake.ts` implements `chrome.i18n` by reading `public/_locales` (`getMessage` with substitutions and Chrome's per-key fallback to English, `getUILanguage`), English by default, and `setUiLanguage(code)` switches a test to another language (`'fr'` for one that is not shipped), so tests compare real English output and can check another language. `readLocaleFile(code)` is the catalog reader tests pass to `applyUiLanguage()`, and `fetchPackagedFile` (installed with `vi.stubGlobal('fetch', ...)`) serves the same files at the fake's `chrome.runtime.getURL()` addresses for code that uses the default reader (the worker). `src/tests/i18n.test.ts` checks that, for every key of every language, the override returns exactly what the fake's `getMessage` returns in that language, and that after the named placeholders are expanded every `$` in every message is `$$` or `$1`..`$9` (real Chrome drops an invalid `$x`, `$0` or a trailing lone `$`, which the override and the fake keep, so no message may contain one); `src/tests/ui-language.test.ts` covers the stored setting. `src/tests/store-listing.test.ts`: every language's store Description and Summary (below).

**The Web Store listing.** `scripts/store-listing.ts` holds, at its top, everything typed into the dashboard: `STORE_DESCRIPTIONS` (one plain-text Description per language, pasted as it is: no Markdown, no long dash, at most 500 characters, the owner's limit; details go to the website and README), the product details, the privacy answers and the reviewers' test instructions, all other text in English. Quoted menu items and buttons use that language's `messages.json` wording (the test checks `assembleName` in each Description and every quoted label in `TEST_INSTRUCTIONS`), and a change to the English Description reaches the three translations in the same edit. Title and Summary are not copied anywhere: the store reads them from the package (`extName` / `extDescription`, Summary at most 132). `src/tests/store-listing.test.ts` checks all of it. `pnpm store:bundle` writes it into `release/store-<version>/SUBMIT.md` with `screenshots/<code>/` folders (a language without its own shows the English ones). `LOCALES=en,ko,es,ja pnpm exec tsx scripts/prepare-registration.ts` shoots the screenshots per language (it opens a visible browser: ask the owner first).

---

## Project website

`site/` is the public website at https://thilllon.github.io/tabinet/: a static Astro site, its own workspace package (`tabinet-site`, listed in `pnpm-workspace.yaml`) sharing the root lockfile. It is not part of the extension: the root `tsconfig.json` includes `src` only, vitest finds no tests there, and oxlint/oxfmt skip `site/dist` and `site/.astro`.

- **Run it**: `pnpm site:dev` (dev server) or `pnpm site:build` (`astro check && astro build` into `site/dist/`), then `pnpm --filter tabinet-site preview` to serve the build.
- **Pages**: home, support (FAQ, how to report a problem, the current version read from the root `package.json`) and privacy, in English (no prefix), Korean (`/ko/`), Spanish (`/es/`) and Japanese (`/ja/`) through Astro's i18n routing. Every page has a language switch that keeps the page, `hreflang` alternates, a canonical URL and Open Graph tags; `@astrojs/sitemap` writes the sitemap and `robots.txt` points at it.
- **Copy stays in step with the product.** The strings are in `site/src/i18n/copy-*.ts`, one file per language, each written natively with Chrome's own terms (탭, 창, 탭 그룹, 고정 탭 / タブ, ウィンドウ, タブグループ, 固定タブ / pestaña, ventana, grupo de pestañas, pestañas fijadas). When a feature, default or FAQ answer changes, change all four (and the store Descriptions in `scripts/store-listing.ts`). The English privacy page renders `PRIVACY_POLICY.md` itself and says it is the authoritative version; `site/src/privacy/{ko,es,ja}.md` are translations of it and must be updated whenever it changes.
- **Screenshots** are imported from `assets/` through `astro:assets` (optimized to WebP at build time, never copied into `site/`); the favicon is `public/img/logo.svg`. Same zero-network rule as the extension: no external fonts, CDNs, analytics, cookies or trackers (Inter comes from `@fontsource-variable/inter`, served by the site itself).
- **Google Search Console**: `site/public/google04dfe5003457b4b3.html` is the verification file, served at the site root. Keep it byte for byte as Google issued it (oxfmt skips it) and never delete it, or the site loses its verified status.
- **Chrome Web Store dashboard URLs** (homepage, support, privacy policy): `PRODUCT_DETAILS` in `scripts/store-listing.ts`.

---

## Sync server

`server/` is the cloud sync backend (stage 1, issue #165; the extension's engine, #170, calls it (configured since #178)): its own workspace package `tabinet-server`, deployed as a Vercel project whose root is `server/`, with Postgres on Neon, live at `https://tabinet-server.vercel.app` (functions in Singapore `sin1`, the database in `aws-ap-southeast-1`; the region is stated in `PRIVACY_POLICY.md`, so a move updates it). `server/README.md` has the API, the limits and the deploy steps.

- **End-to-end encrypted.** The server stores `{kind, id, updatedAt, deleted, iv, ciphertext}` per record (`kind` is `session` or `settings`: saved sessions and settings only, never history snapshots) and never sees a session name, url or title. Every record, a tombstone (`deleted: true`) included, carries an `iv` and a non-empty `ciphertext` under the same size rules; the client binds `kind`/`id`/`updatedAt`/`deleted` to the ciphertext, so the server is not trusted with them. The key setup it keeps (PBKDF2 parameters, salt, a check value) lets a device derive and test the key from the passphrase; it is set once and never replaced.
- **Shape.** One web-standard router, `handle(request, deps)` in `server/src/app.ts`, behind the Vercel function `server/api/index.ts` (`server/vercel.json` rewrites `/v1/*` to it). `deps` = `{ store, verifyGoogleToken, now, randomBytes, allowedOrigins }`, so tests need no network. Every SQL statement is in `server/src/store.ts` over a one-function `query(text, params)` adapter (Neon's HTTP driver in production). `POST /v1/auth/google` takes `{ accessToken }` (a Google OAuth access token from `chrome.identity.getAuthToken`, at most 4096 characters) and checks it with Google's tokeninfo (`server/src/google-auth.ts`: a POST with the token in the form body, never in a URL or a log, 10 s timeout, `fetch` injectable). It is accepted only on HTTP 200 with the token issued to one of `GOOGLE_CLIENT_IDS` (`aud` must match when present, else `azp`, so a token Google issued to another app for the same account is refused), `email_verified` true, non-empty `email` and `sub`, and `expires_in` above 0; a 400 or 401 from Google (its answers for an invalid or expired token) is 401; any other status (429, 408, a 5xx), a network failure or a timeout is a 500, never a false 401, and an empty `GOOGLE_CLIENT_IDS` makes `createGoogleVerifier()` itself throw, so that is a 500 too; bearer tokens are 32 random bytes kept only as their sha256, valid 90 days.
- **Last writer wins** per `(kind, id)` on the client's `updatedAt`, in one conditional upsert statement per record; a tie or an older write is answered `stale` with the stored record. Every applied write takes a new `seq` from one sequence, which is what `GET /v1/records?since=` pages over; the statement locks the user's row first, so a user's writes commit in `seq` order and paging never skips one that committed late. A request body is capped at 4 MiB (413 `payload_too_large`), below Vercel's own 4.5 MB limit.
- **Migrations** are plain SQL, `server/migrations/NNN_name.sql`, applied once each by `pnpm --filter tabinet-server migrate` (`server/scripts/migrate.ts`, tsx; recorded in `schema_migrations`). Never edit a shipped migration; add the next number.
- **Tests** are `server/tests/*.test.ts`, run by `pnpm server:test` with the server's own vitest config; the store and every route run against PGlite (Postgres in WASM) with the real migrations. `pnpm server:typecheck` checks the package with its own `tsconfig.json` (`NodeNext`, so relative imports end in `.js`). The root vitest excludes `server/**`; oxfmt, oxlint and the dash check cover it like everything else.
- **Environment** (Vercel): `DATABASE_URL`, `GOOGLE_CLIENT_IDS` and `ALLOWED_ORIGINS` (comma-separated, e.g. `chrome-extension://bmbpmnfhfbdjdjpblimidmbohgccmjdg`), read in `server/src/production.ts` (`createServer()` builds the deps on the first request and answers a bad environment with a 500). Logs carry an error's name only, never a token, ciphertext or connection string. `server/` pins TypeScript 6: Vercel compiles the function with the project's own `typescript`, and TypeScript 7 has no JS compiler API.

---

## CI/CD

### GitHub Actions (`ci.yml`)

Runs on push to `main`, PRs to `main`, and manual dispatch:

1. Setup mise tools (`jdx/mise-action`; installs Node, pnpm, lefthook and gitleaks from `mise.toml`; the checkout fetches the full history - no Node version matrix)
2. Restore the pnpm store cache (keyed on `pnpm-lock.yaml`)
3. `gitleaks git` over every commit (fails on any finding; config `.gitleaks.toml`)
4. `pnpm install --frozen-lockfile`
5. `pnpm typecheck`
6. `pnpm test` (vitest over the extension; includes `src/tests/store-listing.test.ts`, which fails on a store description over 500 characters, a summary over 132 or a permission without a justification, and `src/tests/i18n.test.ts`, which fails when the `_locales` drift apart)
7. `pnpm server:typecheck` and `pnpm server:test` (the sync server, `server/`; its tests run against PGlite, no database needed)
8. `pnpm format:check` (oxfmt; fails when any file is not formatted)
9. `pnpm lint` (oxlint; fails on any warning or error)
10. `pnpm build`
11. `pnpm site:build` (the project website; `astro check` fails on any type error)

Dependabot (`dependabot.yml`) opens weekly PRs for npm and GitHub Actions updates, grouping minor/patch bumps. Auto-merge is opt-in per pull request and Dependabot never opts its own in, so `dependabot-auto-merge.yml` runs `gh pr merge --auto --squash` on a Dependabot PR whose `update-type` (from `dependabot/fetch-metadata`) is minor or patch - and only when Dependabot itself caused the run, so a commit a person pushes onto its branch is not auto-merged; GitHub then merges it once the required `ci` check passes. Major updates stay open for a person. A merge made with the workflow's `GITHUB_TOKEN` does not start the `push` run of `ci.yml` on `main` - the PR's own run is the evidence.

### Website (`pages.yml`)

Builds `site/` with `pnpm site:build` and deploys `site/dist` to GitHub Pages (`actions/configure-pages`, `actions/upload-pages-artifact`, `actions/deploy-pages`; concurrency group `pages`). Runs on a push to `main` that touches `site/**`, `assets/**`, `public/img/**`, `PRIVACY_POLICY.md`, `package.json` (the version the support page shows), the lockfile, `pnpm-workspace.yaml`, `mise.toml` or the workflow itself, and on manual dispatch. The repository's Pages source must be "GitHub Actions" (Settings > Pages).

### CodeQL (`codeql.yml`)

Security scanning for JavaScript/TypeScript on every push and pull request to main, and weekly (Sundays at 20:00 UTC).

### Release procedure (Chrome Web Store)

`pnpm release` runs release-it (`.release-it.json`): `before:bump` executes `scripts/prepare-registration.ts` (build, Settings + the four `assets/dashboard-*.png` captures, promo tiles), then the version is bumped, `after:bump` runs `pnpm build` + `scripts/zip.ts` (→ `release/Tabinet-<version>.zip`, named from `package.json` `displayName`) + `scripts/store-bundle.ts` (→ `release/store-<version>/`, whose `SUBMIT.md` carries every text from `scripts/store-listing.ts`), and a GitHub release is created. It requires the `main` branch and hooks/CI green. Every optional step of `prepare-registration.ts` is skippable on its own (`SKIP_BUILD`, `SKIP_OPTIONS`, `SKIP_DASHBOARD`, `SKIP_PROMO`), so one asset can be regenerated without a full run; `pnpm exec tsx scripts/zip.ts` packages an existing `dist/` on its own.

1. Release through a pull request like any change: on a `release/vX.Y.Z` branch regenerate whatever store assets changed (`tsx scripts/prepare-registration.ts` with the `SKIP_*` flags for the rest), set the version with `npm version X.Y.Z --no-git-tag-version`, and open a `chore: release vX.Y.Z` pull request. Before merging it, make sure `scripts/store-listing.ts`, `PRIVACY_POLICY.md` (Last Updated), `README.md` and this file describe what ships, and that `package.json` `description` (the store Summary) is ≤ 132 characters.
2. After the merge, on an up-to-date `main`: `pnpm release --ci --no-increment --no-git.commit` with every `SKIP_*` flag set (the assets are already committed). release-it then only builds, zips, writes `release/store-<version>/`, and pushes the `vX.Y.Z` tag; nothing is committed to `main`. If it prints a "releases/new" link instead of creating the GitHub release (no `GITHUB_TOKEN`), create it with `gh release create vX.Y.Z --title vX.Y.Z --notes …`.
3. In the CWS Developer Dashboard, follow `release/store-<version>/SUBMIT.md`: the zip, each language's Description and screenshots, the promo tiles, the Privacy answers (re-review the data-type rows), the Test instructions and Distribution.
4. Submit for review. Never run `pnpm release` from a feature branch or a worktree.

---

## Testing

Unit tests use **Vitest** and live in `src/tests/`, flat, one `<module>.test.ts` per module (never next to the source); the root `tsconfig.json` leaves that folder out and `src/tests/tsconfig.json` checks it. `src/tests/tsconfig.json` type-checks them with Node types added, so a test may use `fs` / `path` while `src/` may not; `pnpm typecheck` is `tsc --noEmit && tsc --noEmit -p src/tests`. Pure sorting logic in `src/lib/sort-order.ts` is tested in `src/tests/sort-order.test.ts`, covering:

- `urlSortKey` - hostname normalization (`www.` stripping), pathname/search/hash ordering, special schemes (`chrome://`, `chrome-extension://`, `file://`, `about:blank`)
- `extractGroupingKey` - subdomain vs domain mode, two-part TLDs (`co.uk`, `ac.kr`, `com.au`)
- `isSuspended` / `tabToUrl` - suspended tab detection and URL extraction
- `findDuplicateTabs` - duplicate detection, `pendingUrl` fallback, special scheme handling
- `sortByTitleOrUrl` - title/URL sorting, pinned tab exclusion, edge cases (empty arrays, mixed schemes, large diverse tab sets)

`vite.config.ts` sets `test.setupFiles: ['src/tests/setup.ts']`, which installs `createChromeFake()` from `src/tests/chrome-fake.ts` on `globalThis.chrome` before every test (typed against `@types/chrome`, no `any`) and a `navigator.locks` shim. Tests reach the fake through `getChromeFake()`: `state`, `fire.installed/startup/menuClicked/command/alarm/actionClicked/tabReplaced`, `failNext(api, n, message)` (`tabs.create`, `tabs.group`, `tabs.move`, `tabGroups.move`, `windows.create`, `storage.local.set`, `scripting.executeScript`) and `commitNavigation(tabId)` (`state.deferCommit` models a navigation that has not committed). The `chrome.tabs`/`chrome.windows`/`chrome.tabGroups` `on*` events are emitted by the fake's own mutations - creating, moving, grouping or closing a tab fires them, which is what `useOpenWindows` is tested against - so only `actionClicked` (the second `action.onClicked` listener) and `tabReplaced` (no mutation produces it) need `fire.*` helpers of their own. Moves between windows follow real Chrome, pinned in `chrome-fake.test.ts`: a cross-window `tabs.move` drops `pinned`, leaves the group, arrives inactive and closes an emptied source window; `tabGroups.move` carries the members and group properties, and carries the source's active tab (expanding the group) when it holds it; activating a tab inside a collapsed group expands it; `tabs.ungroup` of a group's middle tab moves it just after the group (expanding a collapsed group when it is the active tab); `windows.create` honours `type` and `incognito`. `tabs.query({ url })` reads Chrome match patterns (a `*.` host also matches the bare domain). `chrome.permissions` keeps host grants in `state.grantedOrigins` (empty at install), refuses to request anything not in `state.optionalOrigins` and answers prompts with `state.permissionAnswer`; `onAdded`/`onRemoved` fire only on a real change. `chrome.scripting.executeScript` rejects a missing or discarded tab and a host that was not granted, rebuilds `func` from its source text (so a function leaning on an import or closure fails as it would in Chrome) and runs it against a fake `document` whose media elements are `state.pageMedia` (`fakeMedia()`); `state.injectedTabs` records where it ran. `chrome.identity.getAuthToken` answers with `state.authTokenAnswer` (a token, an `Error`, or a function of the request) and records each request in `state.authTokenRequests`; `removeCachedAuthToken` is recorded in `state.removedAuthTokens` and `clearAllCachedAuthTokens` counted in `state.authTokenCacheClears`. Do not relax these - `src/tests/assemble-tabs.test.ts` would pass falsely. Session tests are `src/tests/<module>.test.ts` for each session module of `src/lib/` (naming, migrate, hash, capture invariants, storage order/reconcile/lock/prune/protect, planner chunking and step order, executeRestore against the fake, history dedupe/prune/recovery promotion/alarm re-arm, search tokenising and ranking, export serializers incl. CSV quoting and HTML escaping, import detection/parsers/JSON round-trip, guards on malformed input, suspender unwrap) and `src/tests/service-worker.test.ts` (menus recreated on install, badge, handlers, alarm / second-click / `storage.onChanged` wiring). Page-side logic and hooks are tested in `src/tests/` too (`src/tests/<helper>.test.ts`, `src/tests/use-session-body.test.ts`, `src/tests/use-session-index.test.ts`); React components themselves are not unit-tested (vitest runs in Node without a DOM) - keep decisions in pure helpers with tests and leave components thin.

**Testing a module that registers `chrome.*` listeners at import time** (`src/service-worker.ts`): `src/tests/setup.ts` assigns one throw-away fake to `globalThis.chrome` at module load (just so these modules are importable at all), then installs a **fresh** fake in `beforeEach`. A static `import '@/service-worker'` at the top of a test file runs once, before any `beforeEach`, and registers its listeners on the throw-away instance - every later `getChromeFake().fire.*` call reaches a different fake, so nothing fires. The fix is to defer the import into the test body, after `beforeEach` has installed that test's fake: `vi.resetModules(); await import('@/service-worker');`. `src/tests/service-worker.test.ts`'s `describe('listener wiring', …)` block does exactly this per test (`onInstalled`/`onStartup`/menu-click/command tests), and so does `src/tests/service-worker-sort.test.ts` for the icon click; the same file's other tests call the statically-imported `handleMenuOrCommand()`, `registerContextMenus()`, etc. directly, which is fine since those don't depend on which fake the listeners were registered against. (`src/tests/session-repo.test.ts` also calls `vi.resetModules()` before re-importing `@/lib/session-repo`, but for an unrelated reason - getting a fresh copy of that module's own `fallbackChain` state to test the no-`navigator.locks` code path in isolation, not a listener-registration issue.)

### Real-Chrome smoke test (committed)

`scripts/e2e/smoke.ts` is a committed end-to-end harness that loads the built extension into a real Chromium and drives the app page: build a fixture window (pinned tabs, a titled coloured group, a collapsed group) → Save → the session's own view → Open → rename → delete, verifying each result through `chrome.tabs`/`chrome.tabGroups` inside the extension's own service worker rather than through the UI it just clicked. 11 steps, about 3 s.

```bash
pnpm build && pnpm exec tsx scripts/e2e/smoke.ts
```

It runs under `tsx`, not vitest, so `pnpm test` does not include it - run it by hand after touching restore, capture or the worker's listeners. Steps run in order and a failure stops the run (the rest report `SKIP`); the process exits 1 if any step failed. Flags: `PW_CHROMIUM` (binary, default `/opt/pw-browsers/chromium`), `HEADLESS=0`, `SMOKE_TIMEOUT_MS`, `SMOKE_KEEP_OPEN=1`. `scripts/e2e/browser.ts` (`launchExtension()`) and `fixtures.ts` (sessions seeded straight into `chrome.storage.local`) are shared with `scripts/prepare-registration.ts`; `server.ts` (127.0.0.1 fixture pages - the QA browser has no outbound network) is used only by the e2e scripts (smoke, sort, selection, assemble). Extend it by appending a `Step` to `STEPS`; history, search, export and import are not covered yet.

Playwright itself is a devDependency, used by this harness and by `scripts/prepare-registration.ts` for the release screenshots and promo images. The manual CDP passes described below are what produced the `waitForCommit` and window-state fixes in `src/lib/session-restore.ts`.

### Real-Chrome assemble-tabs check (committed)

`pnpm e2e:assemble` builds into `node_modules/.cache/tabinet/e2e/` (out of sight, rebuilt on every run, safe to lose) with `vite build --mode e2e` (the only build exposing `globalThis.__tabOrganizerE2e`) and runs `scripts/e2e/assemble.ts`: five windows (two pinned tabs and a tab with back/forward history; a collapsed titled group holding the window's active tab next to a tab with a JS value, scroll position and typed input; a window that is only a collapsed three-tab group with its middle tab active; a single-tab group; and a target whose active tab is not its first), then the command through the menu id, then 11 checks - one window left, every tab id kept, exact order, pinned re-pinned in order, each group kept (id/title/colour/collapsed/members) or rebuilt with the same look, `Page.getNavigationHistory` unchanged, page state unchanged (no reload), **zero `tabs.onActivated` events in the target during the run**, focus and ✓ badge. On macOS set `PW_CHROMIUM` to a Chrome for Testing binary (Playwright's own lives under `~/Library/Caches/ms-playwright/chromium-*/`); the headless shell cannot load extensions. It passes `--use-mock-keychain --password-store=basic` so a fresh profile does not stall on a keychain prompt. Test traps: `chrome.tabs.group` needs `createProperties.windowId` or the group lands in the last-focused window; build history with real page navigations (extension-made `tabs.update(url)` history can refuse `goBack`) and verify it over CDP. Split view (Chrome 140+) is only visible as `Tab.splitViewId` / `chrome.tabs.SPLIT_VIEW_ID_NONE` - no extension API creates one, so moving split tabs is not covered.

### Real-Chrome sort check (committed)

`pnpm build && pnpm e2e:sort` runs `scripts/e2e/sort.ts` against the ordinary `dist/`: the click is delivered with `chrome.action.onClicked.dispatch()` inside the service worker, so no e2e hook is needed, and because `sortTabGroups()` is not awaited by its listener each scenario waits for the strip to stop changing. Eight checks: a scrambled window comes out in url order with every tab id kept; a sorted window produces **zero** `tabs.onMoved` events; the last tab dragged to the front is **one** move (the old whole-block call moved every other tab); pinned tabs stay while a titled group and the loose tabs sort within themselves; the group keeps its id, members and title; and the same single-move case inside a group, at the group's edge, leaves the tab in the group. Sorting acts on the last-focused window, so it needs a headed browser (`HEADLESS=0` on this Mac).

### Real-Chrome selection check (committed)

`pnpm build && pnpm e2e:selection` runs `scripts/e2e/selection.ts` against `dist/`: six tabs on two sites (the fixture server under `127.0.0.1` and `localhost`), then eight checks on the Open tabs view - ticking a box swaps the heading for the bar **without moving the list** (the tree's y is compared), shift-click takes the range, Copy really fills the clipboard, Clear brings the heading back, "Select all tabs not like this / like this", Close asks first and closes exactly the ticked tabs, Save & close stores a session of exactly those tabs and closes them, and a click on the row itself still activates the tab. Results are read through `chrome.tabs` / `chrome.storage` in the service worker. Headed on this Mac (`HEADLESS=0`); `SELECTION_SHOTS=<dir>` writes page screenshots. It overwrites the system clipboard with the test links.

### Real-Chrome QA (manual, beyond what the smoke test covers)

Vitest + the chrome fake cannot catch Chrome's own argument validation or its navigation timing, and the smoke test only covers the save/restore/rename/delete path. For anything else - history, search, export, import, window states - drive a real Chrome for Testing build once. What was learned doing it:

- **Do not let Playwright launch the browser when the run can reach `chrome.tabs.discard`.** Its default Chromium launch flags make Chrome for Testing 151 **SIGSEGV on `chrome.tabs.discard`** (i.e. exactly the lazy-restore path). For that path, launch Chrome for Testing yourself with `--load-extension=<dist>` plus `--remote-debugging-port=<port>` (and a scratch `--user-data-dir`), then attach with `chromium.connectOverCDP('http://127.0.0.1:<port>')`. `scripts/e2e/browser.ts` does use `chromium.launchPersistentContext`, which is safe only because its fixture (6 tabs) stays at or below `LAZY_AUTO_THRESHOLD` (10, `src/constants.ts`) and so never discards a tab - keep it that way, or move that harness to CDP first.
- **Pick the right service worker.** Component extensions register service workers too, so `context.serviceWorkers()` has several entries. Select ours by its URL ending in `/service-worker-loader.js` - never by index - and `evaluate` the `chrome.*` calls inside it.
- **`--load-extension` is ignored by branded Chrome ≥ 137.** Use a Chrome for Testing binary (`npx @puppeteer/browsers install chrome@<version>`), not the installed Chrome.
- **Verified this way (do not "simplify" these back):** `chrome.windows.create` rejects `{ state: 'minimized', focused: true }`, `{ state: 'maximized' | 'fullscreen', focused: false }`, and any non-`'normal'` state combined with `left/top/width/height`, all with `Invalid value for state` - so restore always creates a `'normal'`, unfocused window and applies the real state afterwards with `windows.update`. And `chrome.tabs.discard` on a tab whose navigation has not committed silently unloads it with `url: ''`, losing the URL - hence `waitForCommit`. `src/tests/chrome-fake.ts` models both behaviours so the unit tests hold the line.

---

## Common Tasks for Agents

### Adding a new setting

1. Add the type to `src/types.ts`
2. Add a default value to `DEFAULT_SORT_SETTINGS` in `src/lib/sort-settings.ts`
3. Add the control to `src/pages/settings-view.tsx` (with a type guard in `src/lib/sort-settings.ts`) - visible only if it changes what a click on the icon visibly does, otherwise inside "Advanced"
4. Use the setting in the relevant sort/handler function in `src/lib/sort-tabs.ts`

### Adding a new UI component

1. A stock shadcn component: run `pnpm dlx shadcn@latest add <component-name>` (it lands in `src/components/ui/` and stays as generated). Anything hand-made, including a wrapper around a shadcn component, is created in `src/components/`, never in `src/components/ui/`
2. Use the `cn()` utility from `src/lib/utils.ts` for class merging
3. Follow CVA pattern for variant-based components

### Modifying extension permissions

1. Edit the `permissions` array in the `defineManifest()` call in `vite.config.ts`
2. In the same PR update `PERMISSION_JUSTIFICATIONS` in `scripts/store-listing.ts` (an optional host permission: `OPTIONAL_HOST_PERMISSION_JUSTIFICATIONS` and `HOST_PERMISSIONS_AND_REMOTE_CODE`), `PRIVACY_POLICY.md` (Permissions + Last Updated) and its translations in `site/src/privacy/`, `README.md` (the Privacy bullet's permission count and list) and the Permissions Explained table above

### Adding a sessions feature

1. Put pure logic in `src/lib/<module>.ts` with a `src/tests/<module>.test.ts` (use `getChromeFake()` only for the thin chrome wrapper)
2. Persist through `sessionRepo` only - extend `src/lib/session-repo.ts` if a new operation is needed, inside `withLock()`
3. Components go in `src/components/`, hooks in `src/hooks/`, pure page helpers in `src/lib/` (tests in `src/tests/`), and the screen that uses it in `src/pages/`, reachable through a route in `src/lib/app-route.ts`; the service worker only gets new _event_ listeners (`onInstalled`, `onStartup`, menus, commands, alarms, `storage.onChanged`) in `src/service-worker.ts`, registered at module top level
4. Icon-only buttons need `aria-label`; dialogs use the shadcn `Dialog`, menus the shadcn `DropdownMenu`; comment non-obvious Chrome behaviour at the call site

### Changing a session setting

1. Extend `SessionSettings` / `DEFAULT_SESSION_SETTINGS` in `src/types.ts` and `normalizeSettings()` in `src/lib/session-repo.ts` (unknown or invalid stored values must fall back to the default; `historyIntervalMinutes` is any whole number of minutes, clamped to `HISTORY_INTERVAL_MIN_MINUTES`..`HISTORY_INTERVAL_MAX_MINUTES` (1..1440) by `normalizeHistoryInterval()`, with 5/10/30 offered as presets beside "Custom")
2. Read/write through `sessionRepo.getSettings()` / `setSettings(patch)` - `useSessionSettings` on the app page; never `chrome.storage.local` directly
3. Add the control once, in `src/components/session-settings-fields.tsx` (parsing/clamping in `src/lib/session-settings.ts`), and pick its `subset`: `basic` shows it next to the snapshot switch, `advanced` folds it away in the Settings view
4. If the setting affects the alarm, `ensureHistoryAlarm()` already re-runs on every `sessionSettings` change via the worker's `storage.onChanged` listener - do not add another listener
5. Document the new setting on the website (`site/src/i18n/copy-*.ts`, FAQ) and, if it changes what is stored or for how long, in `PRIVACY_POLICY.md`

### Adding a new sort mode

1. Add the mode to `SortBy` type in `src/types.ts`
2. Add a `case` in the `switch` statement inside `sortTabs()` in `src/lib/sort-tabs.ts`
3. Implement the sort function following existing patterns (`sortByTitleOrUrl`, `sortByCustom`)

---

## Gotchas & Edge Cases

- **No `manifest.json` file**: The manifest is defined inline in `vite.config.ts`. Don't look for a separate manifest file.
- **Suspended tabs**: The extension recognises the pages of The Great Suspender's family (The Marvellous Suspender and its forks) by shape, whatever the extension id: `chrome-extension://<32 letters a-p>/suspended.html#ttl=…&pos=…&uri=<real-url>` with the real URL appended raw (not percent-encoded). There is no setting for the suspender's id. `isSuspendedUrl()` / `unwrapSuspendedUrl()` in `src/lib/suspended-url.ts` are the only code that knows the format: sorting (`isSuspended()` / `tabToUrl()` in `sort-order.ts`), capture, the open-windows pane and the restore sanitiser all call them. Unwrapping returns the verbatim remainder after `uri=` - parsing it with `URLSearchParams` would cut the URL at its first `&`. A page of our own extension is never treated as suspended. A wrapper that cannot be unwrapped keeps the raw wrapper URL at capture time and is skipped by `sanitizeRestoreUrl` (foreign `chrome-extension://`) at restore time.
- **Tab group IDs**: `-1` means ungrouped in the Chrome API. The code uses this convention throughout.
- **Tab ID arrays**: Chrome's `tabs.move()` and `tabs.group()` require `[number, ...number[]]` tuple type for non-empty arrays.
- **`scripts/zip.ts` and archiver 8**: archiver 8 is ESM and exports no callable default - the archive classes come by name (`import { ZipArchive } from 'archiver'`). `finalize()` resolves before the file is complete, so the script also waits for the write stream's `close` event; don't "simplify" either back.
- **`pnpm-workspace.yaml`**: Lists two workspace packages, `site` (the project website) and `server` (the sync server); the extension is the root package. It also holds pnpm's install policy: `allowBuilds` (only `esbuild` may run install scripts) and `minimumReleaseAge: 10080` (minutes - only versions published at least 7 days ago are installed; pnpm's default is 1 day). A lockfile entry younger than that makes `pnpm install --frozen-lockfile` fail, in CI too, so `dependabot.yml` carries the matching `cooldown: default-days: 7` for npm. `minimumReleaseAgeExclude` is the escape hatch (exact `name@version`) for a release that must be installed sooner; there is none at the moment.
- **The store text is data, pasted by hand**: `scripts/store-listing.ts` is the only source of the dashboard text; only Title and Summary come from the package (`_locales`).
- **No Python** (set by the owner): every script is TypeScript run with `tsx`; no `.py` file, virtualenv, ruff or pip config in this repository.
- **Pre-push `update-docs` hook amends commits**: on feature branches push with `LEFTHOOK_EXCLUDE=update-docs git push …` and do one manual docs pass per phase.
- **`chrome.tabs.Tab.id` and `chrome.windows.Window.id/state/type/left/top/width/height` are optional** in `@types/chrome` 0.3.x - always narrow before use; never `!`. `Tab.windowId`/`groupId` are required (`-1` = no group).
- **`chrome.storage.local.getKeys()`** needs Chrome 130+; only `reconcile()` uses it, behind a `typeof … === 'function'` guard.
- **App-page singleton**: the sorter still moves/dedupes the app tab like any tab; `openDashboard()` focusing an existing tab is what keeps "close duplicates" harmless. It matches `app.html*`, so it finds the tab whatever view its hash points at.
- **Alarms do not survive an extension update or reload**: `ensureHistoryAlarm()` re-asserts the periodic alarm from `onInstalled` and `onStartup` (`alarms.create` with an existing name replaces it, no churn). If `historyEnabled` is true and `chrome.alarms.getAll()` in the worker console shows nothing, history has silently stopped - that is the first thing to check.
- **The first post-launch snapshot is delayed on purpose**: `onStartup` arms the one-shot `history-first` alarm 1 minute out because Chrome is still restoring tabs while `onStartup` runs; a capture then would record half-loaded windows.
- **`promoteRecoveredSnapshot()` is idempotent**: only snapshots captured _after_ the newest existing recovered one qualify, so a restart with no new snapshot in between never turns another ring entry into a protected one.
- **History dedupe hashes URLs, not titles**: `contentHash()` covers url/pinned/groupIndex/group title, so a page changing its `<title>` never produces a new snapshot; deleting the snapshot that `historyMeta.lastHash` points at also drops `historyMeta`, otherwise the next capture of that layout would be skipped forever.
- **Import never trusts input**: everything pasted or uploaded goes through `src/lib/import-guards.ts`; imported sessions get fresh ids, `kind: 'saved'`, `origin: 'import'` and never keep `protected`. Netscape HTML is parsed with the module's own tokenizer - `DOMParser` is unavailable under vitest (Node, no DOM).
- **Open-windows pane listeners live in the page**: `useOpenWindows` registers `chrome.tabs/windows/tabGroups.on*` in `app.html` and coalesces refetches; `windowId`/`tabId` in `SearchEntry` for open tabs are in-memory only and are never written to storage.
