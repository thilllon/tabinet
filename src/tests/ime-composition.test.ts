import { describe, expect, it } from 'vitest';

import { isComposingEnter, isSubmitShortcut } from '@/lib/ime-composition';

describe('isComposingEnter', () => {
  it('is true while the IME reports a composition', () => {
    expect(isComposingEnter({ nativeEvent: { isComposing: true }, keyCode: 13 })).toBe(true);
  });

  it('is true for the legacy keyCode 229 even when isComposing is false', () => {
    expect(isComposingEnter({ nativeEvent: { isComposing: false }, keyCode: 229 })).toBe(true);
  });

  it('is false for a plain Enter', () => {
    expect(isComposingEnter({ nativeEvent: { isComposing: false }, keyCode: 13 })).toBe(false);
  });
});

describe('isSubmitShortcut', () => {
  const key = (overrides: Partial<Parameters<typeof isSubmitShortcut>[0]> = {}) => ({
    key: 'Enter',
    ctrlKey: false,
    metaKey: false,
    keyCode: 13,
    nativeEvent: { isComposing: false },
    ...overrides,
  });

  it('takes Ctrl+Enter and Command+Enter', () => {
    expect(isSubmitShortcut(key({ ctrlKey: true }))).toBe(true);
    expect(isSubmitShortcut(key({ metaKey: true }))).toBe(true);
  });

  it('leaves a plain Enter to the text box, as a new line', () => {
    expect(isSubmitShortcut(key())).toBe(false);
    expect(isSubmitShortcut(key({ key: 's', ctrlKey: true }))).toBe(false);
  });

  it('ignores the Enter that confirms an IME composition', () => {
    expect(isSubmitShortcut(key({ ctrlKey: true, nativeEvent: { isComposing: true } }))).toBe(
      false,
    );
  });
});
