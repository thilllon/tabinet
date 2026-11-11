import type { SiteCopy } from './site-copy';

export const en: SiteCopy = {
  meta: {
    homeTitle: 'Tabinet - sort, group and save your Chrome tabs',
    homeDescription:
      'A Chrome extension that sorts and groups every tab in one click, handles duplicates, saves whole windows as sessions you can restore, and keeps timestamped notes on YouTube videos. Free, no tracking, and nothing leaves your device unless you turn on the optional encrypted sync.',
    supportTitle: 'Support - Tabinet',
    supportDescription:
      'Answers to common questions about Tabinet, and how to report a problem or ask for a feature.',
    privacyTitle: 'Privacy policy - Tabinet',
    privacyDescription:
      'Tabinet makes no network requests unless you sign in to its optional, end-to-end encrypted sync. What it stores, where, and for how long.',
    ogImageAlt: 'The Tabinet page with a saved session of two windows and their tab groups',
  },
  nav: {
    home: 'Home',
    main: 'Main',
    features: 'Features',
    support: 'Support',
    privacy: 'Privacy',
    language: 'Language',
    skipToContent: 'Skip to content',
    github: 'GitHub',
  },
  cta: {
    addToChrome: 'Add to Chrome',
    note: 'Free · No tracking · Works offline',
    seeFeatures: 'See what it does',
  },
  hero: {
    eyebrow: 'Extension for Chrome',
    title: 'One click, and every tab falls into place.',
    lead: 'Tabinet sorts and groups the tabs in your window, clears out duplicates, and saves whole windows as sessions you can bring back later. Watching a YouTube video? Take timestamped notes beside it. Everything stays on your computer unless you turn on sync.',
    imageAlt:
      'The Tabinet page: saved sessions in the left column, and a session of two windows with its pinned tabs and tab groups on the right',
    languages:
      'The extension itself comes in English, 한국어, Español and 日本語. It follows Chrome’s language, or the one you pick in its Settings.',
  },
  sort: {
    kicker: 'Sorting',
    title: 'Click the icon. That is the whole workflow.',
    lead: 'No popup and no menu to get through. A click on the toolbar icon sorts the window you are in, and you choose once, in Settings, how.',
    before: 'Before',
    after: 'After',
    beforeAlt:
      'A Chrome tab strip before sorting: Hacker News, YouTube, GitHub, Google and Amazon tabs in no particular order',
    afterAlt:
      'The same tab strip after one click: the tabs sorted by site, with the GitHub and Google tabs side by side in tab groups',
    points: [
      'Choose By URL, By title, or Custom, which groups by site in the order you first opened them',
      'Group by full hostname, or by domain so every Google service lands together',
      'Existing tab groups are sorted by name and tidied inside; pinned tabs stay put',
    ],
  },
  rows: [
    {
      shot: 'restore',
      kicker: 'Sessions',
      title: 'Put a project away, and get it back exactly as it was',
      body: 'Save every window from the right-click menu or the Save button, or just the one you are in with a keyboard shortcut you assign. Restoring rebuilds the tab order, pinned tabs, tab groups, the active tab and the window size.',
      points: [
        'Open a session in new windows, or add it to the window you are in',
        'Big sessions load lazily, with progress and a Cancel button',
        'Restoring never deletes the saved session',
      ],
      alt: 'Tabinet asking "Restore 112 tabs?" with the option to load tabs lazily, over a saved session of three windows',
    },
    {
      shot: 'notes',
      kicker: 'YouTube notes',
      title: 'Notes that know where they were in the video',
      body: 'Open YouTube notes from the right-click menu or the Tabinet page, and Chrome’s side panel follows the video you are watching. Each note is stamped with the moment it was taken, and a click on that time jumps the video back there.',
      points: [
        'Add a note at the current time, or a screenshot of the frame on screen',
        'The video can pause while you write, and plays on when you save',
        'Every video’s notes in one place on the Tabinet page, searchable and exportable as Markdown',
      ],
      alt: 'A video’s YouTube notes in Tabinet: four notes listed by time, two of them with a screenshot of the video',
    },
    {
      shot: 'history',
      kicker: 'Automatic snapshots',
      title: 'A safety net for crashes and closed windows',
      body: 'Every 5 minutes, and only when something changed, Tabinet keeps a snapshot of all your open windows. After Chrome restarts, the last one is marked as recovered so you can pick up where you left off.',
      points: [
        'The 20 most recent are kept by default; you choose the interval and the number',
        'Keep moves a snapshot into your saved sessions for good',
        'On by default, off in one click, and then no timer runs at all',
      ],
      alt: 'A recovered snapshot open in Tabinet, with three automatic snapshots listed in the left column',
    },
    {
      shot: 'search',
      kicker: 'Search',
      title: 'Find that one tab, wherever it is',
      body: 'One search box looks through your open windows and every saved session by title, address or site, best matches first. Snapshots are searched too when you ask.',
      points: [
        'Press / to search from anywhere on the page',
        'Arrow keys to move, Enter to open, Esc to clear',
        'A saved tab that is already open is switched to, not opened twice',
      ],
      alt: 'Search results for "github" in Tabinet, listing matching tabs from two saved sessions',
    },
    {
      shot: 'settings',
      kicker: 'Duplicates and settings',
      title: 'Duplicate tabs, handled the way you like',
      body: 'Keep one is the default: extra copies of the same page are closed, keeping the one you are looking at. You can also choose Keep all, or Group them to collect the copies in a tab group to review first.',
      points: [
        'Every setting saves as you change it, no Save button',
        'Advanced options for pinned and suspended tabs stay out of the way',
        'Closed a duplicate by mistake? Ctrl+Shift+T brings it back',
      ],
      alt: 'The Tabinet settings dialog: Sort by set to By URL, Duplicate tabs set to Keep one, and Automatic snapshots switched on',
    },
  ],
  more: {
    title: 'And the rest of the toolkit',
    lead: 'Small things that make a big tab habit easier to live with.',
    cards: [
      {
        icon: 'assemble',
        title: 'Assemble!',
        body: 'Pull the tabs of every other window into the one you are using. Tabs are moved, never reopened, so groups, history and anything you typed survive.',
      },
      {
        icon: 'transfer',
        title: 'Import and export',
        body: 'JSON that imports back exactly, Markdown, plain text, CSV, or HTML bookmarks for Chrome. Import a file or paste a list of links, with a preview first.',
      },
      {
        icon: 'keyboard',
        title: 'Keyboard shortcuts',
        body: 'On a new install, sorting gets Alt+Shift+S, Assemble! Alt+Shift+A and pausing every YouTube video Alt+Shift+P (Option on a Mac); set or change any of them at chrome://extensions/shortcuts. Saving a session and opening Tabinet can have keys of their own.',
      },
      {
        icon: 'grouping',
        title: 'Works with what you use',
        body: 'Tabs suspended by The Marvellous Suspender or a similar suspender sort by their real address. Name your tab groups 1-Work, 2-Reading to set their order.',
      },
    ],
  },
  promise: {
    title: 'Your tabs stay yours',
    lead: 'Without sync, Tabinet sends nothing anywhere and works the same with the network unplugged. With sync, only you can read what is sent.',
    points: [
      {
        title: 'Stays on the device',
        body: 'Sessions, snapshots and YouTube notes live in Chrome’s local extension storage. Snapshots never leave it; saved sessions and notes do only if you turn on sync.',
      },
      {
        title: 'No account needed',
        body: 'Install it and click. Signing in with Google is only for the optional sync, and your sessions are encrypted on the device with a passphrase only you know before they leave it.',
      },
      {
        title: 'No tracking',
        body: 'No analytics, no tracking, and no requests at all unless you sign in to sync. Only on YouTube, once you allow it, does Tabinet run anything in a page: it pauses videos, and for YouTube notes reads the time and title of the video and, when you ask, takes a screenshot of it. Nothing else is read from the pages you visit.',
      },
    ],
    link: 'Read the privacy policy',
  },
  closing: {
    title: 'Give your tabs one click',
    lead: 'Free on the Chrome Web Store. Works in Chrome 123 or newer, and should work in Edge and Brave too.',
  },
  support: {
    title: 'Support',
    lead: 'Answers to the questions people ask most, and how to reach us when something is not right.',
    startTitle: 'Getting started',
    startSteps: [
      'Add Tabinet from the Chrome Web Store, then pin its icon to the toolbar.',
      'Click the icon to sort the window you are in.',
      'Right-click the icon for Assemble!, Save all windows as session, Pause all YouTube videos and YouTube notes. Options opens Tabinet itself, with your sessions, notes and settings.',
    ],
    reportTitle: 'Report a problem',
    reportLead:
      'Found a bug or missing a feature? Open an issue on GitHub. We read every report. It helps to include:',
    reportItems: [
      'your Chrome version (chrome://version) and the Tabinet version',
      'what you did, what you expected, and what happened instead',
      'a screenshot, if the problem is something you can see',
    ],
    reportButton: 'Open an issue on GitHub',
    openIssues: 'See existing issues',
    versionTitle: 'Current version',
    versionText: 'The latest release is version {version}.',
    releases: 'Release notes',
    requirement: 'Requires Chrome 123 or newer.',
    faqTitle: 'Frequently asked questions',
    faq: [
      {
        q: 'Does it sort every window at once?',
        a: 'Sorting works on the window you are in, so click the icon in each window you want to tidy. To bring every window together first, use Assemble! from the right-click menu. Sessions can cover all windows at once.',
      },
      {
        q: 'Will it mess up my pinned tabs?',
        a: 'No. Pinned tabs are left alone by default. If you want them sorted too, turn that on under Advanced in Settings.',
      },
      {
        q: 'Does it send my browsing data anywhere?',
        a: 'Not unless you sign in to sync. Without it, Tabinet makes no network requests at all and everything happens inside your browser. With sync on, your saved sessions, YouTube notes and settings go to Tabinet’s sync server encrypted, so only you can read them; automatic snapshots never leave the device.',
      },
      {
        q: 'Where are my saved sessions stored?',
        a: 'In Chrome’s local extension storage on this device. They are never shared with web pages, and they are uploaded only if you turn on sync, end-to-end encrypted. Delete one session, or all session data, whenever you like; uninstalling removes everything. Export to JSON to keep a backup of your own.',
      },
      {
        q: 'What do automatic snapshots record, and can I turn them off?',
        a: 'A snapshot holds the same data as a saved session: addresses, titles, pinned tabs, tab groups and window layout. One is taken every 5 minutes (you can change that) when something changed, and when you click the icon to sort. The 20 most recent are kept by default (you choose how many), plus any you protect. Switch snapshots off in Settings and no timer runs at all.',
      },
      {
        q: 'How do I restore a session?',
        a: 'Right-click the icon and choose Options (or use your shortcut), pick the session in the left column and press Open. Windows come back with their order, pinned tabs, tab groups and active tab. Open here adds a saved window to the one you are in instead.',
      },
      {
        q: 'Can I move my sessions to another computer?',
        a: 'Yes. Turn on sync on both computers and your saved sessions and YouTube notes follow you. Or export everything as JSON and import that file on the other computer, or export as HTML and import it into Chrome’s bookmarks.',
      },
      {
        q: 'How does sync work, and can the server read my tabs?',
        a: 'Sync is optional and off until you click Sign in with Google in Settings, Account. You then create a sync passphrase; your saved sessions, YouTube notes (with their screenshots) and settings are encrypted with it on your computer before they are sent, and the passphrase itself is never sent, so the server stores only data it cannot read. Snapshots never sync. The server keeps up to 100 screenshots per account; any more stay on the computer where you took them. If you forget the passphrase nobody can recover the copy in the cloud, but the sessions and notes on your computers stay. Delete cloud data in the same place removes everything from the server. Sign-in uses Chrome’s own Google sign-in, so it may not work in other Chromium browsers.',
      },
      {
        q: 'What if I do not like the result of a sort?',
        a: 'Sorting only moves tabs, so nothing is lost. A closed duplicate comes back with Ctrl+Shift+T (Cmd+Shift+T on a Mac).',
      },
      {
        q: 'Can it pause all my YouTube videos at once?',
        a: 'Yes. Right-click the icon and choose Pause all YouTube videos, or press its keyboard shortcut (Alt+Shift+P on a new install, Option+Shift+P on a Mac; set or change it at chrome://extensions/shortcuts). Every YouTube tab in every window pauses where it was; nothing is muted or closed, and running it again resumes nothing. The first time, Settings opens at its YouTube section so you can allow access to YouTube; then choose it again. Pausing only presses pause; YouTube notes, in the side panel, read only the time and title of the video, plus the frame on screen when you press Screenshot. You can remove the access in Settings at any time.',
      },
      {
        q: 'How do YouTube notes work?',
        a: 'Open a YouTube video, then right-click the Tabinet icon and choose YouTube notes (or use the button on the Tabinet page, or a shortcut you set at chrome://extensions/shortcuts). The notes open in Chrome’s side panel. The first time, turn on Access to YouTube there. The Add note button, which shows the current time, saves a note at that moment, Screenshot keeps the frame on screen with a note, and clicking a note’s time moves the video there. Notes stay on your computer, and sync end-to-end encrypted only if you turn on sync. The Tabinet page lists every video’s notes, which you can search and export as Markdown.',
      },
      {
        q: 'Does it work in other Chromium browsers?',
        a: 'It needs Chrome 123 or newer and should work in any Chromium browser of that age with tab groups, including Microsoft Edge and Brave.',
      },
    ],
  },
  privacyPage: {
    notice: 'This English text is the authoritative version of the privacy policy.',
    englishLink: '',
  },
  footer: {
    tagline: 'Sort, group and save your tabs. Nothing leaves your device unless you sync.',
    languages: 'Languages',
  },
};
