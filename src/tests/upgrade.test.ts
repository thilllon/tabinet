import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CLOUD_OWNER_KEY } from '@/lib/cloud-storage';

import { getChromeFake } from './chrome-fake';
import { fakeSyncServer } from './cloud-fetch';
import { V1_CLOUD_KEYS, v1Storage } from './upgrade-fixtures';

const realSetTimeout = globalThis.setTimeout;
async function settle(): Promise<void> {
  for (let turn = 0; turn < 100; turn++) {
    await new Promise((resolve) => realSetTimeout(resolve, 0));
  }
}

async function loadWorker() {
  vi.resetModules();
  const config = await import('@/lib/cloud-config');
  config.overrideCloudSyncConfig(() => ({ apiBase: 'https://sync.test', googleClientId: 'cid' }));
  await import('@/service-worker');
}

beforeEach(() => {
  vi.stubGlobal('fetch', fakeSyncServer().fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe.each(['8.3', '8.4', '9.0', '9.1'] as const)('an update from %s', (version) => {
  it.each([true, false])(
    'keeps every user key byte for byte (signed in to v1: %s)',
    async (signedIn) => {
      const { state, fire } = getChromeFake();
      const before = v1Storage(version, signedIn);
      for (const [name, value] of Object.entries(before)) {
        state.local.set(name, structuredClone(value));
      }
      await loadWorker();
      fire.installed({ reason: 'update', previousVersion: `${version}.0` });
      await settle();
      for (const [name, value] of Object.entries(before)) {
        if ((V1_CLOUD_KEYS as readonly string[]).includes(name)) {
          expect(state.local.has(name), name).toBe(false);
          continue;
        }
        if (name === 'sessionIndex') {
          // Derived data that reconcile() re-derives on every install, as before v10: the same
          // sessions, and the body a newer version wrote listed as unreadable rather than lost.
          const index = state.local.get(name) as {
            sessions: { id: string; unreadable?: unknown }[];
          };
          expect(index.sessions.map((entry) => entry.id).sort()).toEqual([
            'h1',
            'newer',
            's-1_odd',
            's-future',
          ]);
          expect(index.sessions.find((entry) => entry.id === 'newer')?.unreadable).toBeDefined();
          continue;
        }
        expect(JSON.stringify(state.local.get(name)), name).toBe(JSON.stringify(value));
      }
      expect(state.local.get(CLOUD_OWNER_KEY)).toEqual(
        signedIn ? { accountId: null, email: 'Person@Example.com', legacy: true } : undefined,
      );
    },
  );
});

it('the upgrade is idempotent and also runs from a page opened before the install event', async () => {
  const { state } = getChromeFake();
  for (const [name, value] of Object.entries(v1Storage('9.1', true))) {
    state.local.set(name, value);
  }
  const config = await import('@/lib/cloud-config');
  config.overrideCloudSyncConfig(() => ({ apiBase: 'https://sync.test', googleClientId: 'cid' }));
  const { upgradeCloudStorage } = await import('@/lib/cloud-storage');
  expect(await upgradeCloudStorage()).toBe(true);
  expect(await upgradeCloudStorage()).toBe(false);
  expect(V1_CLOUD_KEYS.some((name) => state.local.has(name))).toBe(false);
  config.overrideCloudSyncConfig();
});
