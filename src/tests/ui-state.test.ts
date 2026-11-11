import { afterEach, describe, expect, it } from 'vitest';

import {
  clampSidebarWidth,
  DEFAULT_SIDEBAR_WIDTH,
  HISTORY_OPEN_KEY,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  readNotesPause,
  readUiState,
  writeNotesPause,
  writeUiState,
} from '@/lib/ui-state';

/** Installs a stand-in for the `sessionStorage` vitest's Node environment does not provide. */
function installSessionStorage(store: Pick<Storage, 'getItem' | 'setItem'>): void {
  Object.defineProperty(globalThis, 'sessionStorage', { value: store, configurable: true });
}

function removeSessionStorage(): void {
  Reflect.deleteProperty(globalThis, 'sessionStorage');
}

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

afterEach(() => {
  removeSessionStorage();
});

describe('readUiState / writeUiState', () => {
  it('round-trips a value', () => {
    installSessionStorage(memoryStorage());
    writeUiState(HISTORY_OPEN_KEY, 'true');
    expect(readUiState(HISTORY_OPEN_KEY)).toBe('true');
  });

  it('returns undefined for a key that was never written', () => {
    installSessionStorage(memoryStorage());
    expect(readUiState(HISTORY_OPEN_KEY)).toBeUndefined();
  });

  it('returns undefined when sessionStorage is unavailable', () => {
    removeSessionStorage();
    expect(readUiState(HISTORY_OPEN_KEY)).toBeUndefined();
    expect(() => writeUiState(HISTORY_OPEN_KEY, 'true')).not.toThrow();
  });

  it('swallows accessors that throw (site data blocked)', () => {
    installSessionStorage({
      getItem: () => {
        throw new Error('access denied');
      },
      setItem: () => {
        throw new Error('access denied');
      },
    });
    expect(readUiState(HISTORY_OPEN_KEY)).toBeUndefined();
    expect(() => writeUiState(HISTORY_OPEN_KEY, 'true')).not.toThrow();
  });
});

describe('clampSidebarWidth', () => {
  it('keeps the width between the bounds', () => {
    expect(clampSidebarWidth(300)).toBe(300);
    expect(clampSidebarWidth(10)).toBe(MIN_SIDEBAR_WIDTH);
    expect(clampSidebarWidth(9000)).toBe(MAX_SIDEBAR_WIDTH);
  });

  it('rounds to whole pixels and falls back for a value that is not a number', () => {
    expect(clampSidebarWidth(260.6)).toBe(261);
    expect(clampSidebarWidth(Number.NaN)).toBe(DEFAULT_SIDEBAR_WIDTH);
    expect(clampSidebarWidth(Number.POSITIVE_INFINITY)).toBe(DEFAULT_SIDEBAR_WIDTH);
  });
});

describe('the notes panel pause preference', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'localStorage');
  });

  it('is on until it is turned off, and remembered', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: memoryStorage(),
      configurable: true,
    });
    expect(readNotesPause()).toBe(true);
    writeNotesPause(false);
    expect(readNotesPause()).toBe(false);
    writeNotesPause(true);
    expect(readNotesPause()).toBe(true);
  });

  it('reads as on where there is no storage at all', () => {
    expect(readNotesPause()).toBe(true);
    expect(() => writeNotesPause(false)).not.toThrow();
  });
});
