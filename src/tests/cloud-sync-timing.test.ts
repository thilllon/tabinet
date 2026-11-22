import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CLOUD_ACCOUNT_KEY, CLOUD_SYNC_KEY } from '@/lib/cloud-auth';
import { encryptRecord, toBase64 } from '@/lib/cloud-crypto';
import { CLOUD_SYNC_ALARM, CLOUD_SYNC_SOON_ALARM } from '@/lib/cloud-sync';
import { CLOUD_SYNC_META_KEY, type CloudSyncMeta } from '@/lib/cloud-sync-state';
import { SESSION_SCHEMA_VERSION, type Session } from '@/types';

import { createChromeFake, getChromeFake } from './chrome-fake';
import { fakeSyncServer, type FakeSyncServer } from './cloud-fetch';

/*
 * When sync runs (GitHub issue #257): the real worker against the chrome fake and the fake
 * server, on fake timers. Encryption and storage run for real, so `settle()` lets them finish on
 * the real clock while the fake one stands still.
 */

const START = 1_800_000_000_000;
const ACCOUNT = { token: 'tok', expiresAt: 4_000_000_000_000, email: 'person@example.com' };
const VIDEO = { videoId: 'dQw4w9WgXcQ', title: 'Video' };
const IMAGE = 'data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==';
const realSetTimeout = globalThis.setTimeout;

let server: FakeSyncServer;
let rawKey: string;

async function settle(): Promise<void> {
  for (let turn = 0; turn < 60; turn++) {
    await new Promise((resolve) => realSetTimeout(resolve, 0));
  }
}

/** Moves the fake clock on, then lets what it fired finish. */
async function pass(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await settle();
}

async function loadWorker() {
  vi.resetModules();
  const { overrideCloudSyncConfig } = await import('@/lib/cloud-config');
  overrideCloudSyncConfig(() => ({ apiBase: 'https://sync.test', googleClientId: 'cid' }));
  await import('@/service-worker');
  const { sessionRepo } = await import('@/lib/session-repo');
  const { notesRepo } = await import('@/lib/notes-repo');
  const { syncNow } = await import('@/lib/cloud-sync');
  await settle();
  return { sessionRepo, notesRepo, syncNow };
}

/** A worker on an account that has synced once, with the request log empty. */
async function syncedWorker() {
  const worker = await loadWorker();
  await chrome.storage.local.set({ [CLOUD_ACCOUNT_KEY]: ACCOUNT, [CLOUD_SYNC_KEY]: rawKey });
  await settle();
  server.requests.length = 0;
  return worker;
}

/** Chrome stops the worker: storage and alarms stay, its timers and listeners are gone. */
function killWorker(): void {
  const { local, sync, alarms } = getChromeFake().state;
  const next = createChromeFake();
  for (const [key, value] of local) {
    next.state.local.set(key, value);
  }
  for (const [key, value] of sync) {
    next.state.sync.set(key, value);
  }
  for (const [name, info] of alarms) {
    next.state.alarms.set(name, info);
  }
  Object.assign(globalThis, { chrome: next.chrome, __chromeFake: next });
  vi.clearAllTimers();
}

/** Fires an alarm as Chrome does, which takes a one-shot one away. */
async function fireAlarm(name: string): Promise<void> {
  const { state, fire } = getChromeFake();
  if (name === CLOUD_SYNC_SOON_ALARM) {
    state.alarms.delete(name);
  }
  fire.alarm(name);
  await settle();
}

function session(id: string, updatedAt: number = Date.now()): Session {
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    id,
    kind: 'saved',
    name: id,
    origin: 'manual',
    createdAt: 1,
    updatedAt,
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

const meta = () => getChromeFake().state.local.get(CLOUD_SYNC_META_KEY) as CloudSyncMeta;
const soonAlarm = () => getChromeFake().state.alarms.get(CLOUD_SYNC_SOON_ALARM);
const pulls = () => server.requests.filter((request) => request.method === 'GET').length;

/** A fetch whose first request waits until `release()`. */
function holdFirstRequest(): { release(): void } {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  vi.stubGlobal('fetch', async (...args: Parameters<typeof fetch>) => {
    if (first) {
      first = false;
      await held;
    }
    return server.fetch(...args);
  });
  return { release };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: START });
  rawKey = toBase64(crypto.getRandomValues(new Uint8Array(32)));
  server = fakeSyncServer();
  vi.stubGlobal('fetch', server.fetch);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('becoming ready', () => {
  it('creating or entering the passphrase syncs at once, once', async () => {
    const { sessionRepo } = await loadWorker();
    await sessionRepo.put(session('s1'));
    await chrome.storage.local.set({ [CLOUD_ACCOUNT_KEY]: ACCOUNT });
    await settle();
    expect(server.requests).toHaveLength(0);

    await chrome.storage.local.set({ [CLOUD_SYNC_KEY]: rawKey });
    await settle();
    expect(server.record('session', 's1')).toBeDefined();
    expect(pulls()).toBe(1);
    expect(soonAlarm()).toBeUndefined();

    await pass(60_000);
    expect(pulls()).toBe(1);
  });

  it('signing in with the key already here syncs at once', async () => {
    getChromeFake().state.local.set(CLOUD_SYNC_KEY, rawKey);
    await loadWorker();
    await chrome.storage.local.set({ [CLOUD_ACCOUNT_KEY]: ACCOUNT });
    await settle();
    expect(pulls()).toBe(1);
  });
});

describe('after a local change', () => {
  it('a saved session goes out after the debounce, not before', async () => {
    const { sessionRepo } = await syncedWorker();
    await sessionRepo.put(session('s1'));
    await settle();
    await pass(2499);
    expect(server.requests).toHaveLength(0);
    await pass(1);
    expect(server.record('session', 's1')).toBeDefined();
    expect(soonAlarm()).toBeUndefined();
  });

  it('quick edits go out together', async () => {
    const { sessionRepo } = await syncedWorker();
    for (const id of ['s1', 's2', 's3']) {
      await sessionRepo.put(session(id));
      await settle();
      await pass(2000);
    }
    expect(server.requests).toHaveLength(0);
    await pass(500);
    expect(pulls()).toBe(1);
    expect(server.posts.at(-1)?.count).toBe(3);
  });

  it('edits that never pause still go out within ten seconds', async () => {
    const { sessionRepo } = await syncedWorker();
    for (let second = 0; second < 10; second++) {
      await sessionRepo.put(session('s1'));
      await settle();
      expect(server.requests).toHaveLength(0);
      await pass(1000);
    }
    expect(server.record('session', 's1')).toBeDefined();
  });

  it('a deletion, a note, a screenshot and a setting each go out after the debounce', async () => {
    const { sessionRepo, notesRepo } = await syncedWorker();
    await sessionRepo.put(session('s1', START));
    await settle();
    await pass(2500);

    await sessionRepo.remove('s1');
    await settle();
    await pass(2500);
    expect(server.record('session', 's1')?.deleted).toBe(true);

    await notesRepo.addEntry(VIDEO, { at: 1, text: 'note' });
    await settle();
    await pass(2500);
    expect(server.record('notes', VIDEO.videoId)).toBeDefined();

    await notesRepo.addEntry(VIDEO, { at: 2, text: '', image: IMAGE });
    await settle();
    await pass(2500);
    expect([...server.records.keys()].some((key) => key.startsWith('image:'))).toBe(true);

    const before = server.record('settings', 'settings')?.seq ?? 0;
    await chrome.storage.sync.set({ sortBy: 'title' });
    await settle();
    await pass(2500);
    expect(server.record('settings', 'settings')?.seq).toBeGreaterThan(before);

    await sessionRepo.setSettings({ historyMaxSnapshots: 7 });
    await settle();
    const then = server.record('settings', 'settings')?.seq ?? 0;
    await pass(2500);
    expect(server.record('settings', 'settings')?.seq).toBeGreaterThan(then);
  });

  it('a setting put back within the debounce makes no request', async () => {
    await syncedWorker();
    await chrome.storage.sync.set({ sortBy: 'title' });
    await settle();
    await chrome.storage.sync.remove('sortBy');
    await settle();
    await pass(10_000);
    expect(server.requests).toHaveLength(0);
    expect(soonAlarm()).toBeUndefined();
  });

  it('a snapshot asks for nothing', async () => {
    const { sessionRepo } = await syncedWorker();
    await sessionRepo.put({ ...session('h1'), kind: 'history', origin: 'alarm' });
    await settle();
    await pass(60_000);
    expect(server.requests).toHaveLength(0);
    expect(soonAlarm()).toBeUndefined();
  });

  it('what the page already sent is not sent again', async () => {
    const { sessionRepo, syncNow } = await syncedWorker();
    await sessionRepo.put(session('s1'));
    await settle();
    await syncNow();
    await settle();
    expect(pulls()).toBe(1);
    await pass(10_000);
    expect(pulls()).toBe(1);
  });
});

describe('a stopped worker', () => {
  it('the fallback alarm, 30 seconds out, sends what the dead timer would have', async () => {
    const { sessionRepo } = await syncedWorker();
    await sessionRepo.put(session('s1'));
    await settle();
    expect(soonAlarm()).toEqual({ when: START + 30_000 });

    killWorker();
    await pass(30_000);
    expect(server.requests).toHaveLength(0);

    await loadWorker();
    await fireAlarm(CLOUD_SYNC_SOON_ALARM);
    expect(server.record('session', 's1')).toBeDefined();
    expect(soonAlarm()).toBeUndefined();
  });

  it('later changes never push the fallback back', async () => {
    const { sessionRepo } = await syncedWorker();
    await sessionRepo.put(session('s1'));
    await settle();
    await pass(2000);
    await sessionRepo.put(session('s2'));
    await settle();
    expect(soonAlarm()).toEqual({ when: START + 30_000 });
  });

  it('killed in the middle of a run, the alarm finishes it', async () => {
    // Without Web Locks: a dead worker's lock is the browser's to release, which Node cannot play.
    vi.stubGlobal('navigator', { locks: undefined });
    const { sessionRepo } = await syncedWorker();
    await sessionRepo.put(session('s1'));
    await settle();
    vi.stubGlobal('fetch', () => new Promise<Response>(() => {}));
    await pass(2500);
    expect(soonAlarm()).toBeDefined();

    killWorker();
    vi.stubGlobal('fetch', server.fetch);
    await loadWorker();
    await fireAlarm(CLOUD_SYNC_SOON_ALARM);
    expect(server.record('session', 's1')).toBeDefined();
  });

  it('browser start arms the fallback again for what was left waiting', async () => {
    const { sessionRepo } = await syncedWorker();
    await sessionRepo.put(session('s1'));
    await settle();
    killWorker();
    getChromeFake().state.alarms.clear();
    await loadWorker();
    getChromeFake().fire.startup();
    await settle();
    expect(soonAlarm()).toBeDefined();
    expect(getChromeFake().state.alarms.has(CLOUD_SYNC_ALARM)).toBe(true);
  });

  it('browser start with nothing waiting arms only the periodic check', async () => {
    await syncedWorker();
    getChromeFake().fire.startup();
    await settle();
    expect(soonAlarm()).toBeUndefined();
    expect(getChromeFake().state.alarms.has(CLOUD_SYNC_ALARM)).toBe(true);
  });
});

describe('a change during a run', () => {
  it('goes out in one trailing run', async () => {
    const { sessionRepo } = await syncedWorker();
    await sessionRepo.put(session('s1'));
    await settle();
    const { release } = holdFirstRequest();
    await pass(2500);
    // The run is waiting on the server; three more bursts end meanwhile.
    for (const id of ['s2', 's3', 's4']) {
      await sessionRepo.put(session(id));
      await settle();
      await pass(2500);
    }
    release();
    await settle();
    for (const id of ['s1', 's2', 's3', 's4']) {
      expect(server.record('session', id)).toBeDefined();
    }
    expect(pulls()).toBeLessThanOrEqual(2);
  });

  it('one made after the push was collected follows it', async () => {
    const { sessionRepo } = await syncedWorker();
    await sessionRepo.put(session('s1'));
    await settle();
    let editedMidPush = false;
    vi.stubGlobal('fetch', async (...args: Parameters<typeof fetch>) => {
      if (!editedMidPush && args[1]?.method === 'POST') {
        editedMidPush = true;
        await sessionRepo.put(session('s2'));
      }
      return server.fetch(...args);
    });
    await pass(2500);
    expect(server.record('session', 's2')).toBeUndefined();
    expect(soonAlarm()).toBeDefined();
    await pass(2500);
    expect(server.record('session', 's2')).toBeDefined();
    expect(soonAlarm()).toBeUndefined();
  });
});

describe('a failing server', () => {
  it('is retried after 30 seconds, then less often, up to 15 minutes apart', async () => {
    const { sessionRepo } = await syncedWorker();
    server.offline = true;
    await sessionRepo.put(session('s1'));
    await settle();
    await pass(2500);
    expect(meta().failures).toBe(1);

    for (const seconds of [30, 60, 120, 240, 480, 900, 900]) {
      const when = soonAlarm()?.when ?? 0;
      expect(when - Date.now()).toBe(seconds * 1000);
      const before = server.requests.length;
      await pass(seconds * 1000);
      // Time alone sends nothing: no timer loops behind the alarm.
      expect(server.requests.length).toBe(before);
      await fireAlarm(CLOUD_SYNC_SOON_ALARM);
      expect(server.requests.length).toBe(before + 1);
    }
  });

  it('is not hammered by continuous edits', async () => {
    const { sessionRepo } = await syncedWorker();
    server.offline = true;
    await sessionRepo.put(session('s1'));
    await settle();
    await pass(2500);
    expect(server.requests).toHaveLength(1);
    for (let edit = 0; edit < 10; edit++) {
      await sessionRepo.put(session('s1'));
      await settle();
      await pass(2600);
    }
    expect(server.requests).toHaveLength(1);
  });

  it('a change brings a backed-off retry forward to 30 seconds, no nearer', async () => {
    const { sessionRepo, syncNow } = await syncedWorker();
    server.offline = true;
    for (let run = 0; run < 5; run++) {
      await syncNow();
    }
    await settle();
    expect(soonAlarm()).toEqual({ when: START + 480_000 });
    await pass(1000);
    await sessionRepo.put(session('s1'));
    await settle();
    expect(soonAlarm()).toEqual({ when: START + 31_000 });
  });

  it('back online, the retry sends everything and ends the retries', async () => {
    const { sessionRepo } = await syncedWorker();
    server.offline = true;
    await sessionRepo.put(session('s1'));
    await settle();
    await pass(2500);
    const lastGood = meta().lastSyncAt;
    expect(lastGood).toBe(START);
    server.offline = false;
    await pass(30_000);
    await fireAlarm(CLOUD_SYNC_SOON_ALARM);
    expect(server.record('session', 's1')).toBeDefined();
    expect(meta().failures).toBeUndefined();
    expect(meta().lastError).toBeUndefined();
    expect(meta().lastSyncAt).toBe(Date.now());
    expect(soonAlarm()).toBeUndefined();
  });

  it('a failed pull with nothing to send is retried too', async () => {
    await syncedWorker();
    server.offline = true;
    await fireAlarm(CLOUD_SYNC_ALARM);
    expect(soonAlarm()).toBeDefined();
    server.offline = false;
    await fireAlarm(CLOUD_SYNC_SOON_ALARM);
    expect(meta().failures).toBeUndefined();
  });
});

describe('signing out', () => {
  it('during the debounce sends nothing', async () => {
    const { sessionRepo } = await syncedWorker();
    await sessionRepo.put(session('s1'));
    await settle();
    await pass(1000);
    await chrome.storage.local.remove([CLOUD_ACCOUNT_KEY, CLOUD_SYNC_KEY]);
    await settle();
    await pass(60_000);
    expect(server.requests).toHaveLength(0);
    expect(getChromeFake().state.alarms.has(CLOUD_SYNC_ALARM)).toBe(false);
    expect(soonAlarm()).toBeUndefined();
    expect(meta().dirtySessions.s1).toBeDefined();
  });

  it('while a run is queued sends nothing more', async () => {
    const { sessionRepo } = await syncedWorker();
    await sessionRepo.put(session('s1'));
    await settle();
    const { release } = holdFirstRequest();
    await pass(2500);
    await sessionRepo.put(session('s2'));
    await settle();
    await pass(2500);
    await chrome.storage.local.remove([CLOUD_ACCOUNT_KEY, CLOUD_SYNC_KEY]);
    await settle();
    release();
    await settle();
    await pass(60_000);
    expect(pulls()).toBe(1);
    expect(soonAlarm()).toBeUndefined();
  });

  it('a change while signed out arms nothing, and signing back in sends it at once', async () => {
    const { sessionRepo } = await syncedWorker();
    await chrome.storage.local.remove([CLOUD_ACCOUNT_KEY, CLOUD_SYNC_KEY]);
    await settle();
    await sessionRepo.put(session('s1'));
    await settle();
    await pass(60_000);
    expect(soonAlarm()).toBeUndefined();
    expect(server.requests).toHaveLength(0);
    await chrome.storage.local.set({ [CLOUD_ACCOUNT_KEY]: ACCOUNT, [CLOUD_SYNC_KEY]: rawKey });
    await settle();
    expect(server.record('session', 's1')).toBeDefined();
  });
});

describe('no loop', () => {
  it('applying received sessions and settings asks for no further sync', async () => {
    await syncedWorker();
    const updatedAt = START + 5000;
    const inject = async (kind: 'session' | 'settings', id: string, value: unknown) => {
      const record = { kind, id, updatedAt, deleted: false };
      server.inject({ ...record, ...(await encryptRecord(rawKey, record, value)) });
    };
    await inject('session', 'far', session('far', updatedAt));
    await inject('settings', 'settings', {
      sort: { sortBy: 'title' },
      sessionSettings: { historyMaxSnapshots: 9 },
      uiLanguage: 'ko',
    });
    await fireAlarm(CLOUD_SYNC_ALARM);
    expect(getChromeFake().state.sync.get('sortBy')).toBe('title');
    expect(meta().pendingSettings).toBeUndefined();
    const after = server.requests.length;
    await pass(120_000);
    if (soonAlarm() !== undefined) {
      await fireAlarm(CLOUD_SYNC_SOON_ALARM);
    }
    expect(server.requests.length).toBe(after);
    expect(soonAlarm()).toBeUndefined();
  });

  it('settings the server keeps answering stale and unreadable are not resent on their own', async () => {
    await syncedWorker();
    server.inject({
      kind: 'settings',
      id: 'settings',
      updatedAt: START + 10_000_000,
      deleted: false,
      iv: toBase64(new Uint8Array(12)),
      ciphertext: btoa('not the real ciphertext!'),
    });
    await chrome.storage.sync.set({ sortBy: 'title' });
    await settle();
    await pass(2500);
    const after = server.requests.length;
    await pass(120_000);
    expect(server.requests.length).toBe(after);
    expect(soonAlarm()).toBeUndefined();
    // The next periodic check offers them once more, and no more than that.
    await fireAlarm(CLOUD_SYNC_ALARM);
    const checked = server.requests.length;
    await pass(120_000);
    expect(server.requests.length).toBe(checked);
    expect(soonAlarm()).toBeUndefined();
  });

  it('a record the server refuses waits without a fast retry', async () => {
    const { sessionRepo } = await syncedWorker();
    vi.stubGlobal('fetch', async (...args: Parameters<typeof fetch>) => {
      const response = await server.fetch(...args);
      if (args[1]?.method !== 'POST') {
        return response;
      }
      return new Response(
        JSON.stringify({
          results: [{ kind: 'session', id: 's1', status: 'rejected', reason: 'unknown' }],
        }),
      );
    });
    await sessionRepo.put(session('s1'));
    await settle();
    await pass(2500);
    const after = server.requests.length;
    await pass(120_000);
    expect(server.requests.length).toBe(after);
    expect(soonAlarm()).toBeUndefined();
    expect(meta().lastError).toBeDefined();
  });

  it('a stale push takes the newer copy and stops', async () => {
    const { sessionRepo } = await syncedWorker();
    await sessionRepo.put(session('s1', START));
    await settle();
    const newer = { kind: 'session', id: 's1', updatedAt: START + 9000, deleted: false } as const;
    const payload = await encryptRecord(rawKey, newer, session('s1', newer.updatedAt));
    let raced = false;
    vi.stubGlobal('fetch', async (...args: Parameters<typeof fetch>) => {
      if (!raced && args[1]?.method === 'POST') {
        raced = true;
        server.inject({ ...newer, ...payload });
      }
      return server.fetch(...args);
    });
    await pass(2500);
    expect((await sessionRepo.get('s1'))?.updatedAt).toBe(newer.updatedAt);
    const after = server.requests.length;
    await pass(120_000);
    expect(server.requests.length).toBe(after);
    expect(soonAlarm()).toBeUndefined();
  });

  it('a held screenshot follows the deletion that made room, then it stops', async () => {
    server.imageLimit = 1;
    const { notesRepo } = await syncedWorker();
    const entry = await notesRepo.addEntry(VIDEO, { at: 1, text: '', image: IMAGE });
    await settle();
    await pass(2500);
    await notesRepo.addEntry(VIDEO, { at: 2, text: '', image: IMAGE });
    await settle();
    await pass(2500);
    expect(Object.keys(meta().heldImages ?? {})).toHaveLength(1);

    await notesRepo.removeEntry(VIDEO.videoId, entry.id);
    await settle();
    await pass(2500);
    await pass(2500);
    expect(meta().heldImages).toBeUndefined();
    expect(Object.keys(meta().images?.dirty ?? {})).toEqual([]);
    const after = server.requests.length;
    await pass(120_000);
    expect(server.requests.length).toBe(after);
    expect(soonAlarm()).toBeUndefined();
  });

  it('settings cut short while being written are finished by the alarm', async () => {
    await syncedWorker();
    getChromeFake().state.local.set(CLOUD_SYNC_META_KEY, {
      ...meta(),
      pendingSettings: { sort: { sortBy: 'title' }, sessionSettings: {}, uiLanguage: 'auto' },
    });
    await chrome.storage.sync.set({ groupFrom: 'rightToLeft' });
    await settle();
    expect(soonAlarm()).toBeDefined();
    await pass(10_000);
    expect(server.requests).toHaveLength(0);
    await fireAlarm(CLOUD_SYNC_SOON_ALARM);
    expect(meta().pendingSettings).toBeUndefined();
    expect(getChromeFake().state.sync.get('sortBy')).toBe('title');
    expect(soonAlarm()).toBeUndefined();
  });
});
