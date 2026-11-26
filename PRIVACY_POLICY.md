# Privacy Policy - Tabinet

Last Updated: November 26, 2026

## Overview

Tabinet is a Chrome extension that sorts and organizes your browser tabs and lets you save, restore, search, import and export sets of windows and tabs as sessions. On request it also pauses the videos in your YouTube tabs, and it lets you keep timestamped notes on a YouTube video in Chrome's side panel, and free-form memos on its own page. Your privacy is important to us: everything the extension does happens inside your browser, on your device, unless you choose to sign in to the optional cloud sync (see "Cloud sync" below).

## Data Collection

Unless you sign in to cloud sync, Tabinet does **not** collect or transmit any personal data: it makes no network requests and all operations are performed locally within your browser. Cloud sync is optional and off until you sign in; what it sends, and how it is protected, is described in "Cloud sync" below. Either way, the extension uses no analytics, tracking or telemetry, and reads nothing from the pages you visit except what is described below for YouTube. It runs something inside a web page only on YouTube, and only after you allow it: the pause for YouTube videos, and, for YouTube notes, reading the time and title of the video you are taking notes on and, when you ask, taking a screenshot of it (see "Pausing YouTube videos" and "YouTube notes" below).

### What is stored, and where

When you save a session, and while automatic snapshots are enabled (see below), the extension stores the following about your open windows in Chrome's local extension storage (`chrome.storage.local`) on this device:

- for each tab: its URL, page title, whether it is pinned, and whether it was the active tab
- for each tab group: its name, color and whether it was collapsed
- for each window: its state (normal, minimized, maximized or fullscreen), size and position, and whether it was the focused window
- for each session: the name you gave it (or the generated default), when it was saved and last changed, and a short fingerprint of its tab layout that is used to avoid storing identical snapshots twice
- for each memo: the text you wrote, when it was written and last changed, and, for a copy kept from a sync conflict, which memo it came from
- session settings: whether automatic snapshots are on, their interval, how many to keep, and how large restores are handled

Incognito windows, empty windows and the extension's own pages are never captured. Site icons shown on the Tabinet page come from Chrome's own favicon cache and are not stored by the extension.

Without cloud sync, this data, and your memos, never leave your device: it is not synced through Chrome sync, not uploaded to any server, and not accessible to web pages. Session data leaves the extension only when you choose it: Export writes a file or copies text to your clipboard, on your explicit action only, and, if you sign in to cloud sync, your saved sessions and memos (never your automatic snapshots) are sent to the sync server end-to-end encrypted, as described below.

Your sorting preferences (the grouping mode and how duplicate tabs are handled) and the language you chose for the extension in Settings (if any) are stored with Chrome's sync storage, together with the version number recorded when the extension was installed or updated. If you have Chrome sync enabled, those preferences, and nothing else, may sync across devices signed into the same Chrome account. Session data and session settings are never placed in Chrome's sync storage.

### Automatic snapshots

Automatic snapshots are **on by default**. Every 5 minutes (or another interval you choose, from 1 minute to 24 hours), and each time you click the icon to sort, the extension records the layout of your open windows as described above, but only when something changed since the last snapshot. Snapshots are stored in the same local storage as saved sessions and are subject to the same rules.

To turn snapshots off, open Tabinet (right-click the icon → Options) and switch automatic snapshots off in Settings. With snapshots off, no snapshot timer exists (signed in to cloud sync, the sync timers still run). The extension still wakes briefly when Chrome starts, when it is installed or updated, and when you change a setting, to keep its own saved data tidy. Without cloud sync, none of that touches the network. Signed in to cloud sync, a changed setting is sent within seconds (unless sync is failing: then at the next retry, up to 15 minutes later), and changes left waiting are sent after Chrome starts.

### Pausing YouTube videos

"Pause all YouTube videos", in the icon's right-click menu and as a keyboard shortcut, pauses every video and audio that is playing in your open YouTube tabs, in every window. Each video keeps its place; nothing is muted, closed or reloaded.

For this the extension needs access to youtube.com (`https://*.youtube.com/*`, which covers www, m and music). It is never requested at install: Chrome asks you when you turn on "Access to YouTube" in Settings (choosing the menu item before that opens Settings), and you can remove the access there, or at chrome://extensions, at any time. With that access, each time you ask, the extension runs one small function that is part of the extension itself in each YouTube tab: it presses pause and counts how many videos it paused. It does not read the page, what you watch or anything else on YouTube, and nothing about YouTube is stored or transmitted. Without the access, nothing runs in any web page.

### YouTube notes

"YouTube notes" (in the icon's right-click menu, as a keyboard shortcut you can assign, and as a button on the Tabinet page) opens Chrome's side panel next to the page. While the active tab of that window shows a YouTube video, you can write notes on it, each at a time in the video, and click a note's time to jump the video there.

For each video you take notes on, the extension stores in local extension storage (`chrome.storage.local`) on this device: the video's id and address (`https://www.youtube.com/watch?v=<id>`), its title, the text of each note with the time in the video it belongs to, any screenshot you took for a note (a picture of the video frame, at most 1280 pixels wide), and when each note was written and last changed. Deleting a note deletes its screenshot. Without cloud sync, notes never leave your device. If you sign in to cloud sync, each note is synced as its own end-to-end encrypted item, with its screenshot; the video's id and title are only inside the encrypted content (see "Cloud sync" below).

To work, the panel needs the same access to youtube.com as pausing (see above), which it asks for with the same "Access to YouTube" switch. With it, while the panel is open on a video, a small function that is part of the extension reads that video's current time, its length, whether it is playing, and the page's title, about once a second while the panel is visible; when you ask, it moves the video to a note's time, and, if you leave "Pause the video while I write" on, pauses it while you write a note and plays it again after. When you press Screenshot, it draws the frame the video shows at that moment into a picture and hands it to the panel, which stores it with a new note. It reads nothing else from the page, and what it reads is not stored except as part of a note you save.

### Cloud sync (optional)

Cloud sync keeps your saved sessions, memos, YouTube notes and settings in step across the computers where you use Tabinet. It is **off until you sign in**: open Settings, Account, and click "Sign in with Google". If you never do, nothing in this section applies and the extension makes no network requests. Versions before 10 can no longer sync. Synced data from those versions was erased when version 10's server started; data on your devices was not.

**Signing in.** Chrome gives the extension a Google access token limited to the `openid` and `email` scopes: your email address and Google's stable account id. The extension sends it to Tabinet's sync server, which checks it with Google and forgets it, and the extension drops it from Chrome's cache. The same check is made again when you create, enter or change the sync passphrase, and when you delete your cloud data. The server gives your browser a session token, valid for 90 days. If this device last synced with another account, the extension asks before uploading its data to the new one.

**Keys.** Your first device makes a random data key. It encrypts everything synced with it (AES-GCM, 256-bit). The data key is itself encrypted on your device with a key derived from your passphrase (PBKDF2 with SHA-256, 600,000 rounds, a random salt). The server receives only that encrypted key, seals it again with a key of its own, and gives it out only after Google confirms your account. The passphrase and the data key are never sent. What version 10 stores holds nothing to test a passphrase against without the server's own key. The database provider's recovery history can keep version 9's passphrase records for a limited time, so choose a passphrase you never used for sync before. Someone who controls the server and has its key and database, or who can sign in as you with Google, could try to guess your passphrase, so choose a strong one that differs from your Google password.

The data key stays in local extension storage on each unlocked device, also after a sign-in expires, until you sign out, delete the cloud data there or replace it with another account's. Anyone with access to that browser profile or its backup could read it. An unlocked device can set a new passphrase after a Google check, without the old one. Changing the passphrase does not change the data key, so it does not revoke access from anyone who already obtained that key. Deleting the cloud data and starting again does.

**What is sent, encrypted.**

- your saved sessions, with their tab URLs and titles, tab groups and window layout, and their deletions
- your memos and their deletions
- your YouTube notes, one item per note: the video's id and title, the note's text and time, and their deletions
- the screenshots you took for notes, and their deletions
- your settings: sorting preferences, session settings and language

Automatic snapshots are **never** synced. An account holds up to 50 MB of encrypted data, deletion markers included, and up to 100 screenshots. What does not fit stays on the device and the extension tells you. Deleting always works.

**What the server stores and can see.** For your account: email address, Google account id, when it was created, the sealed key, an identifier and change number of that key, a hash that lets only a holder of the data key replace it, and how much storage you use. For each sign-in: a hash of the session token and when it expires. For each item: the encrypted content, whether it is a session, the settings, a screenshot or a document, a random or opaque identifier, its size, when it changed and whether it was deleted. Memos and notes look alike apart from size. The video id is never outside the encrypted content. Without your data key nobody can read or forge an item. Whoever controls the server, or holds one of your session tokens, could withhold, overwrite, delete or roll items back.

**Where.** The sync server runs on Vercel and its database on Neon, both in the Singapore region. They act as hosting providers. Vercel may record standard request information such as IP addresses in its logs. Google checks the access tokens.

**Retention and deletion.** Synced data and deletion markers are kept until you delete them. "Delete cloud data" in Settings, Account deletes your account and everything stored for it from the live database after a Google check. The database provider's recovery history can keep it for a limited time afterwards. The data on your devices stays. "Sign out" forgets the session token and the data key on that device and leaves the cloud copy.

**Use.** Synced data is used only to sync your own devices. It is never sold, used for advertising, analytics or profiling, or shared beyond the providers above.

## Data Retention

- Saved sessions are kept until you delete them in the Tabinet page.
- Automatic snapshots are kept in a rolling set: only the most recent unprotected snapshots are retained (20 by default; you choose how many in Settings on the Tabinet page), and older ones are removed automatically. A snapshot you mark as protected is kept until you delete it. The "Previous session (recovered)" snapshot created after a browser restart is protected automatically, as is the one before it; older recovered snapshots return to the rolling set and age out of it like any other. Marking one as protected yourself makes it yours to keep. Snapshots can be deleted one at a time or all at once.
- Memos are kept until you delete them on the Tabinet page; after a deletion, Undo is offered for a few seconds.
- "Delete all session data" in the Tabinet page removes every saved session and snapshot immediately; your settings, YouTube notes and memos are kept.
- YouTube notes are kept until you delete them in the notes panel or on the Tabinet page; deleting a video's last note removes everything stored for that video.
- Uninstalling the extension makes Chrome delete all of its stored data on that device. Data on the sync server, if you signed in, stays until you delete it with "Delete cloud data" (sign in again to reach that button).

## Permissions

This extension requires the following permissions:

- **tabs**: Used to read tab URLs and titles for sorting, for saving sessions and for the Tabinet page's list of open windows, and to create tabs when restoring a session.
- **tabGroups**: Used to sort and organize tab groups within the current window and to recreate tab groups when restoring a session.
- **storage**: Used to save your sorting preferences and language choice using Chrome's sync storage, and to store saved sessions, snapshots, session settings, YouTube notes, memos and, if you use cloud sync, its session token, data key and bookkeeping in local storage on this device.
- **contextMenus**: Used to add "Assemble!", "Save all windows as session", "Pause all YouTube videos" and "YouTube notes" to the extension icon's right-click menu. No menu items are added to web pages.
- **unlimitedStorage**: Allows large saved sessions to exceed Chrome's default local storage quota. It does not change where data is stored and sends nothing anywhere.
- **favicon**: Used to display site icons next to tabs in the Tabinet page from Chrome's local favicon cache. No icons are fetched from the network and no icon data is stored by the extension.
- **alarms**: Used as the timer for automatic snapshots on the interval you choose, and, while you are signed in to cloud sync, to check for changes every 15 minutes, to send a change if Chrome stopped the extension before it could, and to retry a sync that failed. When automatic snapshots are off and you are not signed in, no timer exists.
- **identity**: Used only for cloud sync, when you click "Sign in with Google", and to confirm your account when you create, enter or change the passphrase or delete cloud data: it asks Chrome for a Google access token with the `openid` and `email` scopes, as described in "Cloud sync". Without signing in it is never used.
- **scripting**: Used only on YouTube: to pause videos when you ask, as described in "Pausing YouTube videos", and for YouTube notes to read the time and title of the video, move it to a note's time and take a screenshot of it when you ask, as described in "YouTube notes". It works only on the sites you allowed below.
- **sidePanel**: Used to show YouTube notes in Chrome's side panel when you open it from the right-click menu, its keyboard shortcut or the Tabinet page. Clicking the icon never opens it.
- **Access to youtube.com** (optional, `https://*.youtube.com/*`): requested only when you turn on "Access to YouTube" in Settings or in the notes panel, and removable in Settings. Used only to pause videos and, for YouTube notes, to read the video's time and title, move it and take a screenshot of it when you ask; nothing else is read from YouTube pages.

The extension requests no host permissions at install and declares no content scripts; access to youtube.com is optional and only yours to grant. It requires Chrome 123 or newer.

## Data Usage

- Tab URLs and titles are read during sorting and are **not** stored as part of sorting.
- When you save a session, or while automatic snapshots are enabled, the data listed above is stored in local extension storage on your device. Memos you write are stored there too. This data is transmitted only if you sign in to cloud sync, and then only your saved sessions, memos, YouTube notes with their screenshots, and settings, end-to-end encrypted; automatic snapshots never are.
- Sorting preferences are stored using Chrome's built-in storage API; with cloud sync they also go to the sync server, encrypted. They are never shared with third parties.
- Nothing is ever sold, shared, or used for any purpose other than sorting tabs, pausing YouTube videos when you ask, keeping your notes on YouTube videos and your memos, and saving, restoring, searching, importing, exporting and, if you sign in, syncing sessions, memos and notes.

## Third-Party Services

Tabinet does **not** use any third-party analytics, tracking, or data collection services. Cloud sync, only if you sign in, uses Google sign-in and the hosting providers Vercel and Neon, as described in "Cloud sync".

## Changes to This Policy

We may update this privacy policy from time to time. Any changes will be posted on this page with an updated "Last Updated" date.

## Contact

If you have any questions about this privacy policy, please open an issue on the [GitHub repository](https://github.com/thilllon/tabinet/issues).
