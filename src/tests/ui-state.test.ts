import { afterEach, describe, expect, it } from 'vitest';

import { HISTORY_OPEN_KEY, readUiState, writeUiState } from '@/lib/ui-state';

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
