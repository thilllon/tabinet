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

import { DEFAULT_SHORTCUTS } from '@/constants';
import { t } from '@/lib/i18n';
import { shortcutKeys, shortcutText } from '@/lib/shortcut-keys';

const EXECUTE_ACTION = '_execute_action';

/**
 * The fixed wording of the section, read in the UI language when drawn. Functions rather than
 * constants because `chrome.i18n` is only there at run time.
 */
export function sortCommandLabel(): string {
  return t('settingsSortCommand');
}

export function unnamedCommand(): string {
  return t('settingsUnnamedCommand');
}

export function notSetLabel(): string {
  return t('settingsShortcutNotSet');
}

export function commandsLoading(): string {
  return t('settingsShortcutsLoading');
}

export function commandsFailed(): string {
  return t('settingsShortcutsFailed');
}

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
    return sortCommandLabel();
  }
  if (command.description !== undefined && command.description.trim() !== '') {
    return command.description;
  }
  if (command.name !== undefined && command.name.trim() !== '') {
    return command.name;
  }
  return unnamedCommand();
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
