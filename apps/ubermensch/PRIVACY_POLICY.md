# Privacy Policy

**Übermensch** (Chrome extension)

Last Updated: November 26, 2026

Übermensch collects nothing. It has no server of its own, no analytics, no ads and no tracking.
This policy explains what the extension reads, where that goes, and how long it is kept.

## What the extension does

Übermensch shows the Google Drive folder of the open Google Docs, Sheets or Slides file next to the
file's title, for example "My Drive › Projects › 2026", each folder a link to Google Drive. It
does this only after you turn on "Access to Google Docs" in its settings and then click
"Show folder" next to a title and sign in with Google.

## What it reads

- **From the Docs page:** the file id and account number in the page address, and the email
  address of the signed-in Google account as Google's account button shows it, used to ask Google
  for the right account. The extension never reads the document's content.
- **From Google's Drive API** (`www.googleapis.com`), with your own sign-in: metadata of the open
  file and of each folder above it, and nothing else. Exactly these fields: id, name, parent folder
  ids, shared drive id, the owners' display names and the file type
  (`fields=id,name,parents,driveId,owners(displayName),mimeType`); the name of a shared drive; and
  the email address of the account a sign-in belongs to. It never requests file content.

## Sign-in

Sign-in uses Google's own sign-in page in a Chrome window (`chrome.identity.launchWebAuthFlow`),
for the account the document is open in. Übermensch asks for one permission only,
`drive.metadata.readonly` ("See information about your Google Drive files"). It receives an
access token from Google, which expires after about an hour. Sign-in only ever starts from your
click, never when a page loads.

## Where it is kept, and for how long

- The access token is kept in Chrome's session storage, which lives in memory only: it is never
  written to disk, never synced, and is gone when Chrome closes or the token expires. "Sign out"
  in the settings forgets it at once.
- File and folder names, with their parent ids, are kept in the same session storage for a few
  minutes (5 for a file, 10 for a folder, 30 for a shared drive's name), so the path is not
  requested again on every page. "Clear cached folder names" in the settings empties it.
- Nothing is stored in Chrome's local or sync storage.

## Where data goes

Only to Google: the extension's requests go to `accounts.google.com` (sign-in) and
`www.googleapis.com` (the Drive API), with your own token. Nothing is sent to the developer or to
anyone else. Nothing is sold, used for advertising or analytics, or used to determine
creditworthiness. Google's handling of your account is covered by Google's own privacy policy.

## Permissions

- `identity`: Google sign-in from your click on "Show folder".
- `storage`: the in-memory session storage for the token and the short cache.
- `scripting`: registering the extension's packaged script on docs.google.com once you grant
  access, and adding it to Docs tabs already open at that moment.
- `https://docs.google.com/*` (optional, asked for only when you turn on "Access to Google Docs",
  removable there): lets that script show the folder path next to the title of Docs, Sheets and
  Slides files.

No remote code is loaded; everything that runs is packaged with the extension.

## Children

Übermensch is not directed at children and collects no personal information from anyone.

## Changes

A change to this policy is published on this page with a new date above.

## Contact

Questions and requests: https://github.com/thilllon/tabinet/issues
