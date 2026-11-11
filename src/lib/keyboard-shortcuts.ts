/**
 * Keyboard shortcuts: readable key names, the rows of Settings → Keyboard shortcuts, the one-time
 * toast about suggested keys Chrome left unbound, and a way to Chrome's shortcuts page.
 *
 * Readable keyboard shortcuts for Settings.
 *
 * Chrome reports a bound key in two spellings. On a Mac `chrome.commands.getAll()` gives glyphs
 * ("⌥⇧S", "⌘⇧Y", "⌃⇧S"); elsewhere, and in the manifest's `suggested_key`, it is words joined by
 * "+" ("Alt+Shift+S", "Ctrl+Shift+Y"). Both are turned into a list of named keys here, so the page
 * can draw one small chip per key. The glyphs are hard to read at a glance, which is the point.
 */

import { DEFAULT_SHORTCUTS } from '@/constants';
import { type MessageKey, t, uiLocale } from '@/lib/i18n';

type Modifier = 'command' | 'control' | 'alt' | 'shift' | 'search';

const GLYPHS: Readonly<Record<string, Modifier>> = {
  '⌘': 'command',
  '⌃': 'control',
  '⌥': 'alt',
  '⇧': 'shift',
};

/** The modifier names a Mac keyboard prints, in the UI language (read when drawn, not at load). */
function macNames(): Readonly<Record<Modifier, string>> {
  return {
    command: t('settingsKeyCommand'),
    control: t('settingsKeyControl'),
    alt: t('settingsKeyOption'),
    shift: t('settingsKeyShift'),
    search: t('settingsKeySearch'),
  };
}

/** The same for every other platform: Command does not exist there, Ctrl stands in. */
function otherNames(): Readonly<Record<Modifier, string>> {
  return {
    command: t('settingsKeyCtrl'),
    control: t('settingsKeyCtrl'),
    alt: t('settingsKeyAlt'),
    shift: t('settingsKeyShift'),
    search: t('settingsKeySearch'),
  };
}

/**
 * Chrome's names for the keys that are not a letter or a digit, as the manifest spells them
 * ("Comma", "PageUp", "MediaPlayPause") and as Chrome's own shortcut text spells some of them
 * ("Page Up", "Up Arrow", "Media Play/Pause"), compared without spaces and case. A key that is not
 * here (a letter, a digit, an arrow glyph, a name in Chrome's UI language) is shown as Chrome wrote it.
 */
const NAMED_KEYS: Readonly<Record<string, MessageKey>> = {
  comma: 'settingsKeyNameComma',
  period: 'settingsKeyNamePeriod',
  space: 'settingsKeyNameSpace',
  up: 'settingsKeyNameUp',
  uparrow: 'settingsKeyNameUp',
  down: 'settingsKeyNameDown',
  downarrow: 'settingsKeyNameDown',
  left: 'settingsKeyNameLeft',
  leftarrow: 'settingsKeyNameLeft',
  right: 'settingsKeyNameRight',
  rightarrow: 'settingsKeyNameRight',
  home: 'settingsKeyNameHome',
  end: 'settingsKeyNameEnd',
  pageup: 'settingsKeyNamePageUp',
  pagedown: 'settingsKeyNamePageDown',
  insert: 'settingsKeyNameInsert',
  ins: 'settingsKeyNameInsert',
  delete: 'settingsKeyNameDelete',
  del: 'settingsKeyNameDelete',
  tab: 'settingsKeyNameTab',
  esc: 'settingsKeyNameEscape',
  escape: 'settingsKeyNameEscape',
  enter: 'settingsKeyNameEnter',
  return: 'settingsKeyNameEnter',
  backspace: 'settingsKeyNameBackspace',
  medianexttrack: 'settingsKeyNameMediaNextTrack',
  mediaplaypause: 'settingsKeyNameMediaPlayPause',
  'mediaplay/pause': 'settingsKeyNameMediaPlayPause',
  mediaprevtrack: 'settingsKeyNameMediaPrevTrack',
  mediaprevioustrack: 'settingsKeyNameMediaPrevTrack',
  mediastop: 'settingsKeyNameMediaStop',
};

/** The key itself (not a modifier) in the UI language when it has a name, else as written. */
function keyName(key: string): string {
  const named = NAMED_KEYS[key.replace(/\s+/g, '').toLowerCase()];
  return named === undefined ? key : t(named);
}

/**
 * One word of the "+" spelling as a modifier, or `null` for the key itself. In a manifest "Ctrl"
 * means Command on a Mac and "MacCtrl" is the real Control key there.
 */
function wordModifier(word: string, isMac: boolean): Modifier | null {
  switch (word.toLowerCase()) {
    case 'ctrl':
    case 'control':
      return isMac ? 'command' : 'control';
    case 'macctrl':
      return 'control';
    case 'command':
    case 'cmd':
      return 'command';
    case 'alt':
    case 'option':
      return 'alt';
    case 'shift':
      return 'shift';
    case 'search':
      return 'search';
    default:
      return null;
  }
}

/** The key names a shortcut is made of, modifiers first; `[]` for an unbound command. */
export function shortcutKeys(shortcut: string | undefined, isMac: boolean): string[] {
  const text = (shortcut ?? '').trim();
  if (text === '') {
    return [];
  }
  const names = isMac ? macNames() : otherNames();

  if (text.includes('+') && text.length > 1) {
    // "Ctrl++" would be the Plus key; keep a trailing "+" as the key rather than losing it.
    const words = text.endsWith('++') ? [...text.slice(0, -2).split('+'), '+'] : text.split('+');
    return words
      .map((word) => word.trim())
      .filter((word) => word !== '')
      .map((word) => {
        const modifier = wordModifier(word, isMac);
        return modifier === null ? keyName(word) : names[modifier];
      });
  }

  // Glyph spelling: modifier glyphs first, then the key as Chrome wrote it.
  const keys: string[] = [];
  let index = 0;
  const chars = [...text];
  while (index < chars.length - 1) {
    const modifier = GLYPHS[chars[index] ?? ''];
    if (modifier === undefined) {
      break;
    }
    keys.push(names[modifier]);
    index += 1;
  }
  const key = chars.slice(index).join('').trim();
  if (key !== '') {
    keys.push(keyName(key));
  }
  return keys;
}

/** The same keys as one line of text, e.g. "Option + Shift + S". */
export function shortcutText(shortcut: string | undefined, isMac: boolean): string {
  return shortcutKeys(shortcut, isMac).join(' + ');
}

/** Whether a user agent or platform string belongs to a Mac. */
export function isMacPlatform(platform: string): boolean {
  return /mac/i.test(platform);
}

/**
 * The rows of Settings → Keyboard shortcuts, built from `chrome.commands.getAll()`.
 *
 * Every command but one carries the description written in the manifest. The exception is
 * `_execute_action`, Chrome's built-in command for "what a click on the toolbar icon does": Chrome
 * gives it no description (and labels it "Activate the extension" on its own shortcuts page), so
 * the name is supplied here. In this extension that click sorts the window.
 *
 * Chrome reports an unbound command with `shortcut: ''`. That is the usual state on an existing
 * install: Chrome applies a manifest `suggested_key` only when the extension is first installed
 * (and only when no other extension holds the key), never on an update that adds one. So a row
 * must read well with no key at all, and say where the suggested key can be set.
 */

const EXECUTE_ACTION = '_execute_action';

export interface CommandRow {
  /** The command id, stable across renders; the React key. */
  id: string;
  name: string;
  /** The bound keys as readable names ("Option", "Shift", "S"); empty when nothing is bound. */
  keys: string[];
  /** Shown in grey under the name: the suggested key when Chrome has not bound it. */
  hint?: string;
}

function labelOf(command: chrome.commands.Command): string {
  if (command.name === EXECUTE_ACTION) {
    return t('settingsSortCommand');
  }
  if (command.description !== undefined && command.description.trim() !== '') {
    return command.description;
  }
  if (command.name !== undefined && command.name.trim() !== '') {
    return command.name;
  }
  return t('settingsUnnamedCommand');
}

/** The manifest's suggested key for a command id, or `undefined` when it ships without one. */
export function suggestedKeyFor(id: string | undefined): string | undefined {
  if (id === undefined || !Object.hasOwn(DEFAULT_SHORTCUTS, id)) {
    return undefined;
  }
  return DEFAULT_SHORTCUTS[id as keyof typeof DEFAULT_SHORTCUTS];
}

function hintFor(id: string | undefined, keys: readonly string[], isMac: boolean) {
  const suggested = suggestedKeyFor(id);
  if (keys.length > 0 || suggested === undefined) {
    return undefined;
  }
  return t('settingsShortcutSuggestedHint', shortcutText(suggested, isMac));
}

/** Sorting first, as it is the one thing the extension is for, then the rest in manifest order. */
export function commandRows(
  commands: readonly chrome.commands.Command[],
  isMac: boolean,
): CommandRow[] {
  const sortFirst = [
    ...commands.filter((command) => command.name === EXECUTE_ACTION),
    ...commands.filter((command) => command.name !== EXECUTE_ACTION),
  ];
  return sortFirst.map((command, index) => {
    const keys = shortcutKeys(command.shortcut, isMac);
    const hint = hintFor(command.name, keys, isMac);
    return {
      id: command.name !== undefined && command.name !== '' ? command.name : `#${index}`,
      name: labelOf(command),
      keys,
      ...(hint === undefined ? {} : { hint }),
    };
  });
}

/**
 * The one-time toast that says which suggested keyboard shortcuts Chrome left unbound.
 *
 * Chrome applies a manifest `suggested_key` only when the extension is first installed (and only
 * when no other extension holds the key), never on an update that adds one, and no API lets an
 * extension bind a key itself. So an install older than a suggested key never gets it. The app
 * page says so once per command, with a way to Chrome's shortcuts page; the ids already mentioned
 * are kept in `chrome.storage.local` (`SHORTCUT_PROMPT_KEY`), so the toast never comes back for
 * them, but a command that gains a suggested key in a later version is mentioned then.
 */

/** The command ids the toast has already mentioned (`string[]` in `chrome.storage.local`). */
const SHORTCUT_PROMPT_KEY = 'shortcutPrompted';

type SuggestedCommand = keyof typeof DEFAULT_SHORTCUTS;

function isSuggestedCommand(id: string | undefined): id is SuggestedCommand {
  return id !== undefined && Object.hasOwn(DEFAULT_SHORTCUTS, id);
}

/**
 * The commands with a suggested key that Chrome reports unbound and the toast has not mentioned
 * yet, in manifest order of `DEFAULT_SHORTCUTS`. Pure.
 */
export function unpromptedMissingShortcuts(
  commands: readonly chrome.commands.Command[],
  prompted: readonly string[],
): SuggestedCommand[] {
  const unbound = new Set(
    commands
      .filter((command) => (command.shortcut ?? '') === '')
      .map((command) => command.name)
      .filter(isSuggestedCommand),
  );
  return (Object.keys(DEFAULT_SHORTCUTS) as SuggestedCommand[]).filter(
    (id) => unbound.has(id) && !prompted.includes(id),
  );
}

/** The short name a command goes by in the toast (the shortcuts list's names are longer). */
function shortName(id: SuggestedCommand): string {
  switch (id) {
    case '_execute_action':
      return t('shortcutPromptSortName');
    case 'assemble-tabs':
      return t('assembleName');
    case 'pause-youtube':
      return t('cmdPauseYoutube');
  }
}

/** "Assemble! (⌥⇧A) and Pause all YouTube videos (⌥⇧P)" inside one sentence. Pure. */
export function shortcutPromptMessage(ids: readonly SuggestedCommand[], isMac: boolean): string {
  const items = ids.map((id) =>
    t('shortcutPromptItem', shortName(id), shortcutText(DEFAULT_SHORTCUTS[id], isMac)),
  );
  const list = new Intl.ListFormat(uiLocale(), { type: 'conjunction' }).format(items);
  return t('shortcutPromptMessage', list);
}

/** Parses the stored ids; anything that is not a list of strings reads as none. */
export function parsePrompted(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
}

/**
 * Reads Chrome's bindings and the ids already mentioned; when some suggested key is unbound and
 * new, records those ids and returns the toast's text. `undefined` means nothing to say. The ids
 * are recorded before the toast shows, so a page reloaded at once does not say it twice.
 */
export async function takeShortcutPrompt(isMac: boolean): Promise<string | undefined> {
  const [commands, stored] = await Promise.all([
    chrome.commands.getAll(),
    chrome.storage.local.get(SHORTCUT_PROMPT_KEY),
  ]);
  const prompted = parsePrompted(stored[SHORTCUT_PROMPT_KEY]);
  const missing = unpromptedMissingShortcuts(commands, prompted);
  if (missing.length === 0) {
    return undefined;
  }
  await chrome.storage.local.set({ [SHORTCUT_PROMPT_KEY]: [...prompted, ...missing] });
  return shortcutPromptMessage(missing, isMac);
}

/** chrome://extensions/shortcuts may be opened from extension pages via tabs.create. */
export const SHORTCUTS_URL = 'chrome://extensions/shortcuts';

export async function openShortcutSettings(): Promise<void> {
  await chrome.tabs.create({ url: SHORTCUTS_URL });
}
