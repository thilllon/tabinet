import { describe, expect, it } from 'vitest';

import { DARK_CLASS, withDarkClass } from '@/lib/theme';

describe('withDarkClass', () => {
  it('adds the dark class to an empty class attribute', () => {
    expect(withDarkClass('', true)).toBe(DARK_CLASS);
  });

  it('removes it again', () => {
    expect(withDarkClass('dark', false)).toBe('');
  });

  it('keeps other classes and their order', () => {
    expect(withDarkClass('h-full antialiased', true)).toBe('h-full antialiased dark');
    expect(withDarkClass('h-full dark antialiased', false)).toBe('h-full antialiased');
  });

  it('is idempotent: never adds a second dark class', () => {
    expect(withDarkClass('dark', true)).toBe('dark');
    expect(withDarkClass(withDarkClass('a dark b', true), true)).toBe('a b dark');
  });

  it('normalises runs of whitespace left by a previous write', () => {
    expect(withDarkClass('  a   dark  b \n', true)).toBe('a b dark');
    expect(withDarkClass('   ', false)).toBe('');
  });

  it('does not touch classes that merely contain "dark"', () => {
    expect(withDarkClass('darkroom dark-mode', false)).toBe('darkroom dark-mode');
  });
});
