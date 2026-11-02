import { afterEach, describe, expect, it, vi } from 'vitest';

import { CLOUD_ACCOUNT_KEY, CLOUD_SYNC_KEY } from '@/lib/cloud-auth';
import { toBase64 } from '@/lib/cloud-crypto';
import { CLOUD_SYNC_ALARM, CLOUD_SYNC_SOON_ALARM } from '@/lib/cloud-sync';
import { CLOUD_SYNC_META_KEY } from '@/lib/cloud-sync-state';
import { SESSION_SCHEMA_VERSION, type Session } from '@/types';

import { getChromeFake } from './chrome-fake';
import { fakeSyncServer } from './cloud-fetch';

/** Lets every pending promise chain in the worker run to its end. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 200; turn++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const ACCOUNT = { token: 'tok', expiresAt: 4_000_000_000_000, email: 'a@b.c' };

function signIn(): void {
  const { state } = getChromeFake();
  state.local.set(CLOUD_ACCOUNT_KEY, ACCOUNT);
  state.local.set(CLOUD_SYNC_KEY, toBase64(crypto.getRandomValues(new Uint8Array(32))));
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('cloud sync in the worker', () => {
  it('stays dormant while unconfigured: no sync alarm on install, startup or a change', async () => {
    signIn();
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
    signIn();
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
    await chrome.storage.local.set({ [CLOUD_SYNC_KEY]: toBase64(new Uint8Array(32)) });
    await settle();
    expect(fake.state.alarms.has(CLOUD_SYNC_ALARM)).toBe(true);
    expect(fake.state.alarms.has(CLOUD_SYNC_SOON_ALARM)).toBe(true);
    await chrome.storage.local.remove([CLOUD_ACCOUNT_KEY, CLOUD_SYNC_KEY]);
    await settle();
    expect(fake.state.alarms.has(CLOUD_SYNC_ALARM)).toBe(false);
    expect(fake.state.alarms.has(CLOUD_SYNC_SOON_ALARM)).toBe(false);
  });

  it('the sync alarm runs a sync, and a later change asks for one a minute out', async () => {
    signIn();
    const server = fakeSyncServer();
    vi.stubGlobal('fetch', server.fetch);
    const { sessionRepo } = await loadWorker(true);
    const fake = getChromeFake();
    await sessionRepo.put(session('s1'));
    fake.fire.alarm(CLOUD_SYNC_ALARM);
    await settle();
    expect(server.record('session', 's1')).toBeDefined();
    expect(server.record('settings', 'settings')).toBeDefined();

    fake.state.alarms.delete(CLOUD_SYNC_SOON_ALARM);
    await sessionRepo.put(session('s2'));
    await settle();
    expect(fake.state.alarms.get(CLOUD_SYNC_SOON_ALARM)).toMatchObject({ delayInMinutes: 1 });
    fake.fire.alarm(CLOUD_SYNC_SOON_ALARM);
    await settle();
    expect(server.record('session', 's2')).toBeDefined();
  });

  it('a settings change in sync storage marks the settings for the next sync', async () => {
    signIn();
    const server = fakeSyncServer();
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
