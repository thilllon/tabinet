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

import { DEFAULT_SHORTCUTS } from '@/constants';
import { t, uiLocale } from '@/lib/i18n';
import { shortcutText } from '@/lib/shortcut-keys';

/** The command ids the toast has already mentioned (`string[]` in `chrome.storage.local`). */
export const SHORTCUT_PROMPT_KEY = 'shortcutPrompted';

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
