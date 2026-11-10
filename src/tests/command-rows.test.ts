import { describe, expect, it } from 'vitest';

import { commandRows, sortCommandLabel, suggestedKeyFor, unnamedCommand } from '@/lib/command-rows';

describe('commandRows', () => {
  it('names the built-in icon-click command, which Chrome leaves without a description', () => {
    const [row] = commandRows([{ name: '_execute_action', description: '', shortcut: '' }], false);
    expect(row?.name).toBe(sortCommandLabel());
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
      { id: '_execute_action', name: sortCommandLabel(), keys: ['Alt', 'Shift', 'S'] },
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
    expect(nameless?.name).toBe(unnamedCommand());
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
