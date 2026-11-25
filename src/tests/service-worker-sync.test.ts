import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { keyIdOf, toBase64 } from '@/lib/cloud-crypto';
import { CLOUD_ACCOUNT_KEY, CLOUD_KEY_KEY } from '@/lib/cloud-storage';
import { CLOUD_SYNC_ALARM, CLOUD_SYNC_SOON_ALARM } from '@/lib/cloud-sync';
import { CLOUD_SYNC_META_KEY } from '@/lib/cloud-sync-state';
import { SESSION_SCHEMA_VERSION, type Session } from '@/types';

import { getChromeFake } from './chrome-fake';
import { fakeSyncServer } from './cloud-fetch';

const realSetTimeout = globalThis.setTimeout;

/** Lets every pending promise chain in the worker run to its end. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 200; turn++) {
    await new Promise((resolve) => realSetTimeout(resolve, 0));
  }
}

const ACCOUNT = {
  accountId: 'acct',
  token: 'tok',
  expiresAt: 4_000_000_000_000,
  email: 'a@b.c',
  uploadConfirmed: true,
};

async function keyFor(dek: string) {
  return { accountId: ACCOUNT.accountId, keyId: await keyIdOf(dek), generation: 1, dek };
}

/** A ready device, and a server that knows its bearer and key. */
async function signIn() {
  const key = await keyFor(toBase64(crypto.getRandomValues(new Uint8Array(32))));
  const { state } = getChromeFake();
  state.local.set(CLOUD_ACCOUNT_KEY, ACCOUNT);
  state.local.set(CLOUD_KEY_KEY, key);
  const server = fakeSyncServer();
  server.seedAccount({ token: ACCOUNT.token });
  server.seedKey({
    keyId: key.keyId,
    generation: 1,
    envelope: {
      v: 2,
      generation: 1,
      keyId: key.keyId,
      salt: toBase64(new Uint8Array(16)),
      iv: toBase64(new Uint8Array(12)),
      wrapped: toBase64(new Uint8Array(48)),
    },
  });
  return server;
}

/**
 * Loads the worker on this test's fake, with cloud sync configured or not. The config override
 * lives in a module, so it is set on the same fresh module graph the worker is loaded into.
 */
async function loadWorker(configured: boolean) {
  vi.resetModules();
  const config = await import('@/lib/cloud-config');
  config.overrideCloudSyncConfig(() => ({
    apiBase: configured ? 'https://sync.test' : '',
    googleClientId: 'cid',
  }));
  await import('@/service-worker');
  const { sessionRepo } = await import('@/lib/session-repo');
  return { sessionRepo, config };
}

function session(id: string): Session {
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    id,
    kind: 'saved',
    name: id,
    origin: 'manual',
    createdAt: 1,
    updatedAt: 1,
    windows: [
      {
        state: 'normal',
        focused: false,
        groups: [],
        tabs: [{ url: 'https://a.example/', title: 'A', pinned: false, active: true }],
      },
    ],
  };
}

beforeEach(() => {
  // The debounce must not outlive its test; cloud-sync-timing.test.ts drives it.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  // Becoming ready syncs at once, so a server always answers.
  vi.stubGlobal('fetch', fakeSyncServer().fetch);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('cloud sync in the worker', () => {
  it('stays dormant while unconfigured: no sync alarm on install, startup or a change', async () => {
    await signIn();
    const { sessionRepo } = await loadWorker(false);
    const fake = getChromeFake();
    fake.fire.installed({ reason: 'install' });
    fake.fire.startup();
    await sessionRepo.put(session('s1'));
    await settle();
    expect(fake.state.alarms.has(CLOUD_SYNC_ALARM)).toBe(false);
    expect(fake.state.alarms.has(CLOUD_SYNC_SOON_ALARM)).toBe(false);
    expect(fake.state.local.has(CLOUD_SYNC_META_KEY)).toBe(false);
  });

  it('arms the periodic alarm on install and on startup while ready', async () => {
    await signIn();
    await loadWorker(true);
    const fake = getChromeFake();
    fake.fire.installed({ reason: 'update', previousVersion: '1.0.0' });
    await settle();
    expect(fake.state.alarms.get(CLOUD_SYNC_ALARM)).toMatchObject({ periodInMinutes: 15 });
    fake.state.alarms.clear();
    fake.fire.startup();
    await settle();
    expect(fake.state.alarms.has(CLOUD_SYNC_ALARM)).toBe(true);
  });

  it('arms the alarms when the account becomes ready and clears them on sign-out', async () => {
    await loadWorker(true);
    const fake = getChromeFake();
    await chrome.storage.local.set({ [CLOUD_ACCOUNT_KEY]: ACCOUNT });
    await settle();
    expect(fake.state.alarms.has(CLOUD_SYNC_ALARM)).toBe(false);
    // The server does not answer yet: the fallback stands while the first sync runs.
    vi.stubGlobal('fetch', () => new Promise<Response>(() => {}));
    vi.stubGlobal('navigator', { locks: undefined });
    await chrome.storage.local.set({ [CLOUD_KEY_KEY]: await keyFor(toBase64(new Uint8Array(32))) });
    await settle();
    expect(fake.state.alarms.has(CLOUD_SYNC_ALARM)).toBe(true);
    expect(fake.state.alarms.has(CLOUD_SYNC_SOON_ALARM)).toBe(true);
    await chrome.storage.local.remove([CLOUD_ACCOUNT_KEY, CLOUD_KEY_KEY]);
    await settle();
    expect(fake.state.alarms.has(CLOUD_SYNC_ALARM)).toBe(false);
    expect(fake.state.alarms.has(CLOUD_SYNC_SOON_ALARM)).toBe(false);
  });

  it('the sync alarm runs a sync, and a later change arms the 30-second fallback', async () => {
    const server = await signIn();
    vi.stubGlobal('fetch', server.fetch);
    const { sessionRepo } = await loadWorker(true);
    const fake = getChromeFake();
    await sessionRepo.put(session('s1'));
    fake.fire.alarm(CLOUD_SYNC_ALARM);
    await settle();
    expect(server.record('session', 's1')).toBeDefined();
    expect(server.record('settings', 'settings')).toBeDefined();

    fake.state.alarms.delete(CLOUD_SYNC_SOON_ALARM);
    const before = Date.now();
    await sessionRepo.put(session('s2'));
    await settle();
    const when = fake.state.alarms.get(CLOUD_SYNC_SOON_ALARM)?.when ?? 0;
    expect(when).toBeGreaterThanOrEqual(before + 30_000);
    expect(when).toBeLessThanOrEqual(Date.now() + 30_000);
    fake.fire.alarm(CLOUD_SYNC_SOON_ALARM);
    await settle();
    expect(server.record('session', 's2')).toBeDefined();
  });

  it('a settings change in sync storage marks the settings for the next sync', async () => {
    const server = await signIn();
    vi.stubGlobal('fetch', server.fetch);
    await loadWorker(true);
    const fake = getChromeFake();
    fake.fire.alarm(CLOUD_SYNC_ALARM);
    await settle();
    const before = server.record('settings', 'settings')?.seq;
    fake.state.alarms.delete(CLOUD_SYNC_SOON_ALARM);
    await chrome.storage.sync.set({ sortBy: 'title' });
    await settle();
    expect(fake.state.alarms.has(CLOUD_SYNC_SOON_ALARM)).toBe(true);
    fake.fire.alarm(CLOUD_SYNC_SOON_ALARM);
    await settle();
    expect(server.record('settings', 'settings')?.seq).toBeGreaterThan(before ?? 0);
  });
});
