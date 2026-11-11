import { describe, expect, it } from 'vitest';

import { t } from '@/lib/i18n';
import {
  commandRows,
  isMacPlatform,
  parsePrompted,
  shortcutKeys,
  shortcutPromptMessage,
  shortcutText,
  suggestedKeyFor,
  unpromptedMissingShortcuts,
} from '@/lib/keyboard-shortcuts';

import { getChromeFake } from './chrome-fake';

describe('shortcutKeys', () => {
  it('names the glyphs Chrome reports on a Mac', () => {
    expect(shortcutKeys('⌥⇧S', true)).toEqual(['Option', 'Shift', 'S']);
    expect(shortcutKeys('⌘⇧Y', true)).toEqual(['Command', 'Shift', 'Y']);
    expect(shortcutKeys('⌃⇧S', true)).toEqual(['Control', 'Shift', 'S']);
  });

  it('keeps a named key after the glyphs whole', () => {
    expect(shortcutKeys('⌥Comma', true)).toEqual(['Option', 'Comma']);
    expect(shortcutKeys('⌘⇧PageDown', true)).toEqual(['Command', 'Shift', 'Page Down']);
    expect(shortcutKeys('⌘↑', true)).toEqual(['Command', '↑']);
  });

  it('reads the "+" spelling with the names of each platform', () => {
    expect(shortcutKeys('Alt+Shift+S', false)).toEqual(['Alt', 'Shift', 'S']);
    expect(shortcutKeys('Ctrl+Shift+Y', false)).toEqual(['Ctrl', 'Shift', 'Y']);
    expect(shortcutKeys('Alt+Shift+S', true)).toEqual(['Option', 'Shift', 'S']);
    // In a manifest Ctrl means Command on a Mac, and MacCtrl is the Control key.
    expect(shortcutKeys('Ctrl+Shift+Y', true)).toEqual(['Command', 'Shift', 'Y']);
    expect(shortcutKeys('MacCtrl+Shift+Y', true)).toEqual(['Control', 'Shift', 'Y']);
    expect(shortcutKeys('Command+B', true)).toEqual(['Command', 'B']);
  });

  it('keeps the Plus key', () => {
    expect(shortcutKeys('Ctrl++', false)).toEqual(['Ctrl', '+']);
  });

  it('returns nothing for an unbound command', () => {
    expect(shortcutKeys('', true)).toEqual([]);
    expect(shortcutKeys('   ', false)).toEqual([]);
    expect(shortcutKeys(undefined, false)).toEqual([]);
  });
});

describe('named keys', () => {
  it("names every key Chrome reports by name, in both of Chrome's spellings", () => {
    expect(shortcutKeys('Ctrl+Shift+Comma', false)).toEqual(['Ctrl', 'Shift', 'Comma']);
    expect(shortcutKeys('Alt+Period', false)).toEqual(['Alt', 'Period']);
    expect(shortcutKeys('Alt+Space', false)).toEqual(['Alt', 'Space']);
    expect(shortcutKeys('Alt+Up', false)).toEqual(['Alt', 'Up Arrow']);
    expect(shortcutKeys('Alt+Down Arrow', false)).toEqual(['Alt', 'Down Arrow']);
    expect(shortcutKeys('Alt+PageUp', false)).toEqual(['Alt', 'Page Up']);
    expect(shortcutKeys('Alt+Page Up', false)).toEqual(['Alt', 'Page Up']);
    expect(shortcutKeys('MediaPlayPause', false)).toEqual(['Play/Pause']);
    expect(shortcutKeys('Media Play/Pause', false)).toEqual(['Play/Pause']);
    expect(shortcutKeys('MediaNextTrack', false)).toEqual(['Next Track']);
    expect(shortcutKeys('MediaPrevTrack', false)).toEqual(['Previous Track']);
    expect(shortcutKeys('MediaStop', false)).toEqual(['Stop']);
    for (const key of ['Left', 'Right', 'Home', 'End', 'Insert', 'Delete', 'Tab']) {
      expect(shortcutKeys(`Ctrl+${key}`, false)).toHaveLength(2);
    }
    // Letters, digits, glyphs and anything Chrome already wrote in its own language pass through.
    expect(shortcutKeys('Ctrl+Shift+7', false)).toEqual(['Ctrl', 'Shift', '7']);
    expect(shortcutKeys('Alt+쉼표', false)).toEqual(['Alt', '쉼표']);
  });

  it('translates the names into the UI language', () => {
    getChromeFake().setUiLanguage('es');
    expect(shortcutKeys('Ctrl+Shift+Comma', false)).toEqual(['Ctrl', 'Mayús', 'Coma']);
    expect(shortcutKeys('Alt+PageDown', false)).toEqual(['Alt', 'Av Pág']);
    getChromeFake().setUiLanguage('ja');
    expect(shortcutKeys('MediaPlayPause', false)).toEqual(['再生/一時停止']);
  });
});

describe('shortcutText', () => {
  it('joins the names with spaced plus signs', () => {
    expect(shortcutText('⌥⇧S', true)).toBe('Option + Shift + S');
    expect(shortcutText('Alt+Shift+A', false)).toBe('Alt + Shift + A');
    expect(shortcutText('', false)).toBe('');
  });
});

describe('isMacPlatform', () => {
  it('recognises a Mac user agent and nothing else', () => {
    expect(
      isMacPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'),
    ).toBe(true);
    expect(isMacPlatform('MacIntel')).toBe(true);
    expect(isMacPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe(false);
    expect(isMacPlatform('Mozilla/5.0 (X11; Linux x86_64)')).toBe(false);
  });
});

describe('commandRows', () => {
  it('names the built-in icon-click command, which Chrome leaves without a description', () => {
    const [row] = commandRows([{ name: '_execute_action', description: '', shortcut: '' }], false);
    expect(row?.name).toBe(t('settingsSortCommand'));
    expect(row?.keys).toEqual([]);
  });

  it('lists sorting first and keeps the others in the order Chrome gave them', () => {
    const rows = commandRows(
      [
        {
          name: 'save-session',
          description: 'Save the current window as a session',
          shortcut: '',
        },
        { name: 'assemble-tabs', description: 'Move the tabs', shortcut: 'Alt+A' },
        { name: '_execute_action', description: '', shortcut: 'Alt+Shift+S' },
      ],
      false,
    );
    expect(rows).toEqual([
      { id: '_execute_action', name: t('settingsSortCommand'), keys: ['Alt', 'Shift', 'S'] },
      { id: 'save-session', name: 'Save the current window as a session', keys: [] },
      { id: 'assemble-tabs', name: 'Move the tabs', keys: ['Alt', 'A'] },
    ]);
  });

  it('turns the glyphs Chrome reports on a Mac into key names', () => {
    const [row] = commandRows([{ name: '_execute_action', shortcut: '⌥⇧S' }], true);
    expect(row?.keys).toEqual(['Option', 'Shift', 'S']);
    expect(row?.hint).toBeUndefined();
  });

  it('points at the suggested key when Chrome left a suggested command unbound', () => {
    // An existing install updated to a version that adds a suggested_key keeps it unbound.
    const [row] = commandRows(
      [{ name: 'assemble-tabs', description: 'Assemble!', shortcut: '' }],
      true,
    );
    expect(row?.keys).toEqual([]);
    expect(row?.hint).toContain('Option + Shift + A');
    expect(row?.hint).not.toContain(' - ');
  });

  it('gives no hint to a command that ships without a suggestion', () => {
    const [row] = commandRows([{ name: 'save-session', description: 'Save', shortcut: '' }], false);
    expect(row?.hint).toBeUndefined();
  });

  it('never leaves a row without a name', () => {
    expect(commandRows([{ name: 'mystery' }], false)[0]?.name).toBe('mystery');
    expect(commandRows([{ name: 'mystery', description: '  ' }], false)[0]?.name).toBe('mystery');
    const [nameless] = commandRows([{ description: '' }], false);
    expect(nameless?.name).toBe(t('settingsUnnamedCommand'));
    expect(nameless?.id).not.toBe('');
  });
});

describe('suggestedKeyFor', () => {
  it('reads the manifest suggestions and nothing inherited', () => {
    expect(suggestedKeyFor('_execute_action')).toBe('Alt+Shift+S');
    expect(suggestedKeyFor('save-session')).toBeUndefined();
    expect(suggestedKeyFor('toString')).toBeUndefined();
    expect(suggestedKeyFor(undefined)).toBeUndefined();
  });
});

const commands = (bound: Record<string, string>): chrome.commands.Command[] =>
  ['_execute_action', 'save-session', 'open-dashboard', 'assemble-tabs', 'pause-youtube'].map(
    (name) => ({ name, description: '', shortcut: bound[name] ?? '' }),
  );

describe('unpromptedMissingShortcuts', () => {
  it('lists the commands with a suggested key that Chrome left unbound, in DEFAULT_SHORTCUTS order', () => {
    expect(unpromptedMissingShortcuts(commands({ _execute_action: '⌥⇧S' }), [])).toEqual([
      'assemble-tabs',
      'pause-youtube',
    ]);
  });

  it('ignores commands that ship without a suggested key', () => {
    const all = commands({ _execute_action: 'S', 'assemble-tabs': 'A', 'pause-youtube': 'P' });
    expect(unpromptedMissingShortcuts(all, [])).toEqual([]);
  });

  it('never mentions a command twice', () => {
    expect(unpromptedMissingShortcuts(commands({}), ['_execute_action', 'assemble-tabs'])).toEqual([
      'pause-youtube',
    ]);
  });

  it('treats a missing shortcut field as unbound', () => {
    expect(unpromptedMissingShortcuts([{ name: 'assemble-tabs' }], [])).toEqual(['assemble-tabs']);
  });
});

describe('shortcutPromptMessage', () => {
  it('names each command with its suggested key in one sentence', () => {
    const message = shortcutPromptMessage(['assemble-tabs', 'pause-youtube'], false);
    expect(message).toContain('Assemble! (Alt + Shift + A)');
    expect(message).toContain('Pause all YouTube videos (Alt + Shift + P)');
    expect(message).toContain(' and ');
  });
});

describe('parsePrompted', () => {
  it('keeps strings and reads anything else as none', () => {
    expect(parsePrompted(['a', 1, 'b'])).toEqual(['a', 'b']);
    expect(parsePrompted('a')).toEqual([]);
    expect(parsePrompted(undefined)).toEqual([]);
  });
});
