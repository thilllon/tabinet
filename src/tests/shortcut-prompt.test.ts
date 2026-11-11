import { describe, expect, it } from 'vitest';

import {
  parsePrompted,
  shortcutPromptMessage,
  unpromptedMissingShortcuts,
} from '@/lib/shortcut-prompt';

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
