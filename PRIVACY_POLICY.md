# Privacy Policy - Tabinet

Last Updated: November 10, 2026

## Overview

Tabinet is a Chrome extension that sorts and organizes your browser tabs and lets you save, restore, search, import and export sets of windows and tabs as sessions. On request it also pauses the videos in your YouTube tabs. Your privacy is important to us: everything the extension does happens inside your browser, on your device, unless you choose to sign in to the optional cloud sync (see "Cloud sync" below).

## Data Collection

Unless you sign in to cloud sync, Tabinet does **not** collect or transmit any personal data: it makes no network requests and all operations are performed locally within your browser. Cloud sync is optional and off until you sign in; what it sends, and how it is protected, is described in "Cloud sync" below. Either way, the extension reads nothing from the pages you visit and uses no analytics, tracking or telemetry. The only thing it ever runs inside a web page is a pause for YouTube videos, and only after you allow it (see "Pausing YouTube videos" below).

### What is stored, and where

When you save a session, and while automatic snapshots are enabled (see below), the extension stores the following about your open windows in Chrome's local extension storage (`chrome.storage.local`) on this device:

- for each tab: its URL, page title, whether it is pinned, and whether it was the active tab
- for each tab group: its name, color and whether it was collapsed
- for each window: its state (normal, minimized, maximized or fullscreen), size and position, and whether it was the focused window
- for each session: the name you gave it (or the generated default), when it was saved and last changed, and a short fingerprint of its tab layout that is used to avoid storing identical snapshots twice
- session settings: whether automatic snapshots are on, their interval, how many to keep, and how large restores are handled

Incognito windows, empty windows and the extension's own pages are never captured. Site icons shown on the Tabinet page come from Chrome's own favicon cache and are not stored by the extension.

Without cloud sync, this data never leaves your device: it is not synced through Chrome sync, not uploaded to any server, and not accessible to web pages. Session data leaves the extension only when you choose it: Export writes a file or copies text to your clipboard, on your explicit action only, and, if you sign in to cloud sync, your saved sessions (never your automatic snapshots) are sent to the sync server end-to-end encrypted, as described below.

Your sorting preferences (the grouping mode and how duplicate tabs are handled) and the language you chose for the extension in Settings (if any) are stored with Chrome's sync storage, together with the version number recorded when the extension was installed or updated. If you have Chrome sync enabled, those preferences, and nothing else, may sync across devices signed into the same Chrome account. Session data and session settings are never placed in Chrome's sync storage.

### Automatic snapshots

Automatic snapshots are **on by default**. Every 5 minutes (or another interval you choose, from 1 minute to 24 hours), and each time you click the icon to sort, the extension records the layout of your open windows as described above, but only when something changed since the last snapshot. Snapshots are stored in the same local storage as saved sessions and are subject to the same rules.

To turn snapshots off, open Tabinet (right-click the icon → Options) and switch automatic snapshots off in Settings. With snapshots off, no timer exists. The extension still wakes briefly when Chrome starts, when it is installed or updated, and when you change a setting, to keep its own saved data tidy; none of that touches the network.

### Pausing YouTube videos

"Pause all YouTube videos", in the icon's right-click menu and as a keyboard shortcut, pauses every video and audio that is playing in your open YouTube tabs, in every window. Each video keeps its place; nothing is muted, closed or reloaded.

For this the extension needs access to youtube.com (`https://*.youtube.com/*`, which covers www, m and music). It is never requested at install: Chrome asks you when you turn on "Access to YouTube" in Settings (choosing the menu item before that opens Settings), and you can remove the access there, or at chrome://extensions, at any time. With that access, each time you ask, the extension runs one small function that is part of the extension itself in each YouTube tab: it presses pause and counts how many videos it paused. It does not read the page, what you watch or anything else on YouTube, and nothing about YouTube is stored or transmitted. Without the access, nothing runs in any web page.

### Cloud sync (optional)

Cloud sync keeps your saved sessions and your settings in step across the computers where you use Tabinet. It is **off until you sign in**: open Settings, Account, and click "Sign in with Google". If you never do, nothing in this section applies and the extension makes no network requests.

**Signing in.** Chrome asks for your permission and then gives the extension a Google access token for the Google account Chrome is signed in to, limited to the `openid` and `email` scopes: your email address and Google's stable account id, nothing else from your Google account. The extension sends that token once to Tabinet's sync server, which checks it with Google and then forgets it; the extension drops it from Chrome's cache right after. The server then gives your browser its own session token, valid for 90 days, which the extension keeps in local extension storage.

**What is sent, and how it is protected.** Before any session or setting is sent, you create a sync passphrase. A key is derived from it on your device (PBKDF2 with SHA-256, 600,000 rounds, a random salt) and everything synced is encrypted with that key using AES-GCM (256-bit). The passphrase and the key are never sent anywhere. What is sent, encrypted:

- your saved sessions, with their tab URLs and titles, tab groups and window layout, and deletions of saved sessions
- your settings: sorting preferences, session settings and the language you chose

Automatic snapshots are **never** synced. Because the server never has your passphrase or key, it cannot read your sessions or settings, and nobody, including us, can recover them if you forget the passphrase (the sessions on your devices are not affected).

**What the server stores.** For your account: your email address, your Google account id, the time the account was created, and the key setup your devices need to test a passphrase (the salt, the number of rounds and an encrypted check value, none of which reveals the passphrase). For each sign-in: a hash of the session token (never the token itself) and when it expires. For each synced item: the encrypted content, whether it is a session or the settings, a random identifier, the time it was last changed, and whether it was deleted. A session you delete stays on the server as an encrypted deletion marker, so your other devices learn about it, until you delete your cloud data.

**Where.** The sync server runs on Vercel and its database on Neon, both in the Singapore region (Asia Pacific). They act as our hosting providers and process this data only to run the service; as part of serving requests, Vercel may record standard request information such as IP addresses in its logs. Signing in also involves Google, which checks the access token.

**Retention and deletion.** Synced data is kept until you delete it. "Delete cloud data" in Settings, Account, deletes your account and everything stored for it on the server, at once and for good; the sessions on your devices stay. "Sign out" stops syncing on that device and forgets its session token and key, but leaves your data on the server for your other devices. A session token expires 90 days after sign-in; sign in again to continue.

**Use.** Synced data is used only to sync your own devices. It is never sold, never used for advertising, analytics or profiling, and never shared with anyone except the hosting providers above, to run the service.

## Data Retention

- Saved sessions are kept until you delete them in the Tabinet page.
- Automatic snapshots are kept in a rolling set: only the most recent unprotected snapshots are retained (20 by default; you choose how many in Settings on the Tabinet page), and older ones are removed automatically. A snapshot you mark as protected is kept until you delete it. The "Previous session (recovered)" snapshot created after a browser restart is protected automatically, as is the one before it; older recovered snapshots return to the rolling set and age out of it like any other. Marking one as protected yourself makes it yours to keep. Snapshots can be deleted one at a time or all at once.
- "Delete all session data" in the Tabinet page removes every saved session and snapshot immediately; your settings are kept.
- Uninstalling the extension makes Chrome delete all of its stored data on that device. Data on the sync server, if you signed in, stays until you delete it with "Delete cloud data" (sign in again to reach that button).

## Permissions

This extension requires the following permissions:

- **tabs**: Used to read tab URLs and titles for sorting, for saving sessions and for the Tabinet page's list of open windows, and to create tabs when restoring a session.
- **tabGroups**: Used to sort and organize tab groups within the current window and to recreate tab groups when restoring a session.
- **storage**: Used to save your sorting preferences and language choice using Chrome's sync storage, and to store saved sessions, snapshots, session settings and, if you use cloud sync, its session token and key in local storage on this device.
- **contextMenus**: Used to add "Assemble!", "Save all windows as session" and "Pause all YouTube videos" to the extension icon's right-click menu. No menu items are added to web pages.
- **unlimitedStorage**: Allows large saved sessions to exceed Chrome's default local storage quota. It does not change where data is stored and sends nothing anywhere.
- **favicon**: Used to display site icons next to tabs in the Tabinet page from Chrome's local favicon cache. No icons are fetched from the network and no icon data is stored by the extension.
- **alarms**: Used as the timer for automatic snapshots on the interval you choose, and, while you are signed in to cloud sync, to sync every 15 minutes and shortly after a change. When automatic snapshots are off and you are not signed in, no timer exists.
- **identity**: Used only for cloud sync, when you click "Sign in with Google": it asks Chrome for a Google access token with the `openid` and `email` scopes, as described in "Cloud sync". Without signing in it is never used.
- **scripting**: Used only to pause YouTube videos when you ask, as described in "Pausing YouTube videos". It works only on the sites you allowed below.
- **Access to youtube.com** (optional, `https://*.youtube.com/*`): requested only when you turn on "Access to YouTube" in Settings, and removable there. Used only to pause videos; nothing is read from YouTube pages.

The extension requests no host permissions at install and declares no content scripts; access to youtube.com is optional and only yours to grant. It requires Chrome 123 or newer.

## Data Usage

- Tab URLs and titles are read during sorting and are **not** stored as part of sorting.
- When you save a session, or while automatic snapshots are enabled, the data listed above is stored in local extension storage on your device. It is transmitted only if you sign in to cloud sync, and then only your saved sessions and settings, end-to-end encrypted; automatic snapshots never are.
- Sorting preferences are stored using Chrome's built-in storage API; with cloud sync they also go to the sync server, encrypted. They are never shared with third parties.
- Nothing is ever sold, shared, or used for any purpose other than sorting tabs, pausing YouTube videos when you ask, and saving, restoring, searching, importing, exporting and, if you sign in, syncing sessions.

## Third-Party Services

Tabinet does **not** use any third-party analytics, tracking, or data collection services. Cloud sync, only if you sign in, uses Google sign-in and the hosting providers Vercel and Neon, as described in "Cloud sync".

## Changes to This Policy

We may update this privacy policy from time to time. Any changes will be posted on this page with an updated "Last Updated" date.

## Contact

If you have any questions about this privacy policy, please open an issue on the [GitHub repository](https://github.com/thilllon/tabinet/issues).
