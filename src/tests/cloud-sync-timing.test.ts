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
  // Clearing the fake timers puts their clock back to the start: the time is kept.
  const now = Date.now();
  vi.clearAllTimers();
  vi.setSystemTime(now);
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

const realLocks = navigator.locks;
let testNumber = 0;

/** Locks of this test's own: one left hanging (a dead worker, a hung fetch) blocks no other test. */
function ownLocks() {
  testNumber += 1;
  const prefix = `t${testNumber}:`;
  return {
    request: (name: string, ...rest: unknown[]) =>
      Reflect.apply(realLocks.request, realLocks, [prefix + name, ...rest]) as Promise<unknown>,
    query: async () => ({
      held: (await realLocks.query()).held
        ?.filter((lock) => lock.name?.startsWith(prefix))
        .map(({ name, mode }) => ({ name: name?.slice(prefix.length), mode })),
    }),
  };
}

beforeEach(() => {
  vi.stubGlobal('navigator', { locks: ownLocks() });
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
    // At the alarm's own time, the run's start plus the retry.
    await pass(30_000);
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

  it('a change never brings a backed-off retry forward', async () => {
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
    await pass(2500);
    expect(soonAlarm()).toEqual({ when: START + 480_000 });
    expect(server.requests).toHaveLength(5);
  });

  it('a browser start brings it forward to 30 seconds', async () => {
    const { syncNow } = await syncedWorker();
    server.offline = true;
    for (let run = 0; run < 5; run++) {
      await syncNow();
    }
    await settle();
    killWorker();
    await loadWorker();
    getChromeFake().fire.startup();
    await settle();
    expect(soonAlarm()).toEqual({ when: START + 30_000 });
    expect(meta().retryAt).toBe(START + 30_000);
    server.offline = false;
    await pass(30_000);
    await fireAlarm(CLOUD_SYNC_SOON_ALARM);
    expect(meta().failures).toBeUndefined();
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
    await pass(30_000);
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

/*
 * The review of #257: slow and hung servers, a worker that dies at any await, account switches.
 * These move the alarms along with the clock, as Chrome does.
 */
const realSetImmediate = globalThis.setImmediate;

async function tick(turns = 20): Promise<void> {
  for (let turn = 0; turn < turns; turn++) {
    await new Promise((resolve) => realSetImmediate(resolve));
  }
}

/** One step of simulated time: timers, then every alarm that is due. */
async function step(ms = 2000): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await tick();
  const { state, fire } = getChromeFake();
  for (const alarm of await chrome.alarms.getAll()) {
    if (alarm.scheduledTime > Date.now() || !state.alarms.has(alarm.name)) {
      continue;
    }
    if (alarm.periodInMinutes === undefined) {
      state.alarms.delete(alarm.name);
    } else {
      await chrome.alarms.create(alarm.name, {
        when: alarm.scheduledTime + alarm.periodInMinutes * 60_000,
        periodInMinutes: alarm.periodInMinutes,
      });
    }
    fire.alarm(alarm.name);
    await tick();
  }
}

async function simulate(ms: number, each?: (elapsed: number) => Promise<void>): Promise<void> {
  const from = Date.now();
  while (Date.now() - from < ms) {
    await step();
    await each?.(Date.now() - from);
  }
}

type Answer = (...args: Parameters<typeof fetch>) => Promise<Response>;

/** A server that answers `ms` later, and the times it was asked. */
function slowFetch(ms: number, answer: Answer): number[] {
  const asked: number[] = [];
  vi.stubGlobal('fetch', async (...args: Parameters<typeof fetch>) => {
    asked.push(Date.now());
    await new Promise((resolve) => setTimeout(resolve, ms));
    return answer(...args);
  });
  return asked;
}

const serverError: Answer = async () => new Response('{"error":"internal"}', { status: 500 });

/** A fetch that answers nothing, and gives up only when it is aborted. */
const hungFetch: Answer = (_input, init) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
  });

/** The server refuses every write of a session for a reason this version does not know. */
const refusingPosts: Answer = async (...args) => {
  const response = await server.fetch(...args);
  return args[1]?.method === 'POST'
    ? Response.json({
        results: [{ kind: 'session', id: 's1', status: 'rejected', reason: 'unknown' }],
      })
    : response;
};

describe('a slow or failing server over an hour', { timeout: 60_000 }, () => {
  it.each([5, 24, 29, 31, 45])('an error after %i seconds keeps its backoff', async (seconds) => {
    const { sessionRepo } = await syncedWorker();
    const asked = slowFetch(seconds * 1000, serverError);
    await sessionRepo.put(session('s1'));
    await simulate(3_600_000);
    expect(asked.length).toBeGreaterThan(3);
    expect(asked.length).toBeLessThanOrEqual(12);
    for (let index = 1; index < asked.length; index++) {
      const wanted = Math.min(30_000 * 2 ** (index - 1), 900_000);
      expect(asked[index]! - asked[index - 1]!).toBeGreaterThanOrEqual(wanted - 2000);
    }
  });

  it('a slow server with an item it refuses is asked again at the periodic check only', async () => {
    const { sessionRepo } = await syncedWorker();
    const asked = slowFetch(16_000, refusingPosts);
    await sessionRepo.put(session('s1'));
    await simulate(3_600_000);
    expect(asked.length).toBeLessThanOrEqual(12);
  });

  it.each([20, 120])('an edit every %i seconds does not shorten the backoff', async (seconds) => {
    const { sessionRepo } = await syncedWorker();
    server.offline = true;
    await sessionRepo.put(session('s1'));
    let next = seconds * 1000;
    await simulate(3_600_000, async (elapsed) => {
      if (elapsed >= next) {
        next += seconds * 1000;
        await sessionRepo.put(session('s1'));
      }
    });
    expect(server.requests.length).toBeGreaterThan(3);
    expect(server.requests.length).toBeLessThanOrEqual(12);
  });

  it('runs the worker does not survive back off too, and count as failed', async () => {
    vi.stubGlobal('navigator', { locks: undefined });
    const { sessionRepo } = await syncedWorker();
    const asked: number[] = [];
    vi.stubGlobal('fetch', () => {
      asked.push(Date.now());
      return new Promise<Response>(() => {});
    });
    await sessionRepo.put(session('s1'));
    let killed = 0;
    await simulate(3_600_000, async () => {
      const last = asked.at(-1);
      if (last !== undefined && asked.length > killed && Date.now() - last >= 10_000) {
        killed = asked.length;
        killWorker();
        await loadWorker();
      }
    });
    expect(asked.length).toBeGreaterThan(3);
    expect(asked.length).toBeLessThanOrEqual(12);
    expect(meta().failures).toBeGreaterThan(3);
  });

  it('a request that never answers ends as a failure and lets go of the lock', async () => {
    const { syncNow } = await syncedWorker();
    vi.stubGlobal('fetch', hungFetch);
    let outcome: string | undefined;
    void syncNow().then((result) => (outcome = result.outcome));
    await settle();
    await pass(25_001);
    expect(outcome).toBe('failed');
    expect(meta().failures).toBe(1);
    expect((await navigator.locks.query()).held ?? []).toEqual([]);
  });

  it('a check queued behind a failing Sync now does not retry in the same instant', async () => {
    const { syncNow } = await syncedWorker();
    const asked = slowFetch(3000, serverError);
    const manual = syncNow();
    await settle();
    await fireAlarm(CLOUD_SYNC_ALARM);
    await pass(3000);
    await manual;
    await settle();
    expect(asked).toHaveLength(1);
  });
});

describe('a worker that dies at the wrong moment', { timeout: 60_000 }, () => {
  beforeEach(() => {
    vi.stubGlobal('navigator', { locks: undefined });
  });

  it('after the alarm fired during a run, a fallback still stands', async () => {
    const { sessionRepo } = await syncedWorker();
    await sessionRepo.put(session('s1'));
    await settle();
    vi.stubGlobal('fetch', () => new Promise<Response>(() => {}));
    await pass(2500);
    await pass(27_500);
    await fireAlarm(CLOUD_SYNC_SOON_ALARM);
    killWorker();
    expect(soonAlarm()).toBeDefined();

    vi.stubGlobal('fetch', server.fetch);
    await loadWorker();
    await simulate(120_000);
    expect(server.record('session', 's1')).toBeDefined();
  });

  it('a retry with nothing to send keeps its alarm', async () => {
    await syncedWorker();
    server.offline = true;
    await fireAlarm(CLOUD_SYNC_ALARM);
    await pass(30_000);
    vi.stubGlobal('fetch', () => new Promise<Response>(() => {}));
    await fireAlarm(CLOUD_SYNC_SOON_ALARM);
    killWorker();
    expect(soonAlarm()).toBeDefined();
  });

  it('work the run made itself has the fallback behind it', async () => {
    await syncedWorker();
    getChromeFake().state.local.set(CLOUD_SYNC_META_KEY, {
      ...meta(),
      images: { dirty: {}, deleted: {}, known: {} },
      heldImages: { held1: START },
    });
    getChromeFake().state.local.set('noteImage:held1', IMAGE);
    const gone = { kind: 'image', id: 'gone1', updatedAt: START + 5, deleted: true } as const;
    server.inject({ ...gone, ...(await encryptRecord(rawKey, gone, { deleted: true })) });
    vi.stubGlobal('fetch', (...args: Parameters<typeof fetch>) =>
      args[1]?.method === 'POST' ? new Promise<Response>(() => {}) : server.fetch(...args),
    );
    await fireAlarm(CLOUD_SYNC_ALARM);
    killWorker();
    expect(meta().images?.dirty.held1).toBeDefined();
    expect(soonAlarm()).toBeDefined();
  });

  /** From the `alive`th Chrome call or request on, none completes: the worker died there. */
  function dieAfter(alive: number): { died(): boolean } {
    let calls = 0;
    let dead = false;
    const guard =
      <A extends unknown[], T>(call: (...args: A) => T) =>
      (...args: A): T => {
        calls += 1;
        if (calls > alive) {
          dead = true;
          return new Promise(() => {}) as T;
        }
        return call(...args);
      };
    const { local, sync } = chrome.storage;
    const { alarms } = chrome;
    for (const [target, names] of [
      [local, ['get', 'set']],
      [sync, ['get', 'set']],
      [alarms, ['create', 'get', 'clear']],
    ] as const) {
      const api = target as unknown as Record<string, (...args: unknown[]) => unknown>;
      for (const name of names) {
        api[name] = guard(api[name]!.bind(target));
      }
    }
    vi.stubGlobal('fetch', guard(server.fetch));
    return { died: () => dead };
  }

  it.each(['retry', 'sign-in'] as const)('at every await of a %s', async (scenario) => {
    // The first call is made as the event is delivered, before anything could be awaited.
    for (let alive = 1; alive < 80; alive++) {
      const fresh = createChromeFake();
      Object.assign(globalThis, { chrome: fresh.chrome, __chromeFake: fresh });
      server = fakeSyncServer();
      vi.stubGlobal('fetch', server.fetch);
      vi.setSystemTime(START);
      const { sessionRepo } = scenario === 'retry' ? await syncedWorker() : await loadWorker();
      if (scenario === 'retry') {
        server.offline = true;
        await sessionRepo.put(session('s1'));
        await settle();
        await pass(2500);
        server.offline = false;
        await pass(30_000);
      } else {
        await sessionRepo.put(session('s1'));
        await settle();
      }
      // Taken before the guard: the page's write is not the worker's to lose.
      const pageWrite = chrome.storage.local.set.bind(chrome.storage.local);
      const worker = dieAfter(alive);
      if (scenario === 'retry') {
        getChromeFake().state.alarms.delete(CLOUD_SYNC_SOON_ALARM);
        getChromeFake().fire.alarm(CLOUD_SYNC_SOON_ALARM);
      } else {
        await pageWrite({ [CLOUD_ACCOUNT_KEY]: ACCOUNT, [CLOUD_SYNC_KEY]: rawKey });
      }
      await tick(120);
      if (!worker.died()) {
        // The run got to its end: every await before it was a place to die.
        expect(alive).toBeGreaterThan(15);
        expect(server.record('session', 's1')).toBeDefined();
        return;
      }
      killWorker();
      vi.stubGlobal('fetch', server.fetch);
      await loadWorker();
      await simulate(130_000);
      expect(server.record('session', 's1'), `died after call ${alive}`).toBeDefined();
    }
    throw new Error('the run never got to its end');
  });
});

describe('signed out or switched during a run', () => {
  const signOutHere = async () => {
    await chrome.storage.local.remove([CLOUD_ACCOUNT_KEY, CLOUD_SYNC_KEY]);
    await settle();
  };

  it('the old 401 does not sign the new sign-in out', async () => {
    const { sessionRepo } = await syncedWorker();
    await sessionRepo.put(session('s1'));
    await settle();
    const { release } = holdFirstRequest();
    await pass(2500);
    await signOutHere();
    server.token = 'tok2';
    await chrome.storage.local.set({
      [CLOUD_ACCOUNT_KEY]: { ...ACCOUNT, token: 'tok2' },
      [CLOUD_SYNC_KEY]: rawKey,
    });
    release();
    await settle();
    await settle();
    expect(getChromeFake().state.local.get(CLOUD_ACCOUNT_KEY)).toMatchObject({ token: 'tok2' });
    expect(server.record('session', 's1')).toBeDefined();
  });

  it('nothing edited after sign-out is sent', async () => {
    const { sessionRepo } = await syncedWorker();
    await sessionRepo.put(session('s1'));
    await settle();
    const { release } = holdFirstRequest();
    await pass(2500);
    await signOutHere();
    await sessionRepo.put(session('after'));
    release();
    await settle();
    expect(server.requests.filter((request) => request.method === 'POST')).toEqual([]);
  });

  it('a switch neither sends to the old account nor takes from it', async () => {
    const { sessionRepo } = await syncedWorker();
    const only = {
      kind: 'session',
      id: 'only-in-a',
      updatedAt: START + 9,
      deleted: false,
    } as const;
    server.inject({ ...only, ...(await encryptRecord(rawKey, only, session(only.id, START + 9))) });
    const other = fakeSyncServer('tok-b');
    await sessionRepo.put(session('s1'));
    await settle();
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    vi.stubGlobal('fetch', async (...args: Parameters<typeof fetch>) => {
      if (new Headers(args[1]?.headers).get('authorization') === 'Bearer tok-b') {
        return other.fetch(...args);
      }
      await held;
      return server.fetch(...args);
    });
    await pass(2500);
    await signOutHere();
    await chrome.storage.local.set({
      [CLOUD_ACCOUNT_KEY]: { ...ACCOUNT, token: 'tok-b', email: 'other@example.com' },
      [CLOUD_SYNC_KEY]: toBase64(crypto.getRandomValues(new Uint8Array(32))),
    });
    await sessionRepo.put(session('made-as-b'));
    release();
    await settle();
    await pass(2500);
    await settle();
    expect(server.record('session', 'made-as-b')).toBeUndefined();
    expect(await sessionRepo.get('only-in-a').catch(() => undefined)).toBeUndefined();
    expect(other.record('session', 'only-in-a')).toBeUndefined();
    expect(other.record('session', 'made-as-b')).toBeDefined();
  });
});

describe('a change while recovering, and a clock set back', () => {
  it('a change during the successful retry follows in seconds', async () => {
    const { sessionRepo } = await syncedWorker();
    server.offline = true;
    await sessionRepo.put(session('s1'));
    await settle();
    await pass(2500);
    server.offline = false;
    await pass(30_000);
    let edited = false;
    vi.stubGlobal('fetch', async (...args: Parameters<typeof fetch>) => {
      if (!edited && args[1]?.method === 'POST') {
        edited = true;
        await sessionRepo.put(session('s2'));
      }
      return server.fetch(...args);
    });
    await fireAlarm(CLOUD_SYNC_SOON_ALARM);
    await pass(2500);
    expect(server.record('session', 's2')).toBeDefined();
  });

  it('a change stamped in the future is not a change during every run', async () => {
    const { sessionRepo } = await syncedWorker();
    vi.stubGlobal('fetch', refusingPosts);
    vi.setSystemTime(START + 3_600_000);
    await sessionRepo.put(session('s1'));
    await settle();
    vi.setSystemTime(START);
    await pass(2500);
    expect(soonAlarm()).toBeUndefined();
  });

  it('and does not hold the backoff at 30 seconds', async () => {
    const { sessionRepo, syncNow } = await syncedWorker();
    server.offline = true;
    vi.setSystemTime(START + 3_600_000);
    await sessionRepo.put(session('s1'));
    await settle();
    vi.setSystemTime(START);
    for (let run = 0; run < 4; run++) {
      await syncNow();
    }
    expect(soonAlarm()).toEqual({ when: START + 240_000 });
  });

  it('a retry time left in the future by the clock does not stop the retries', async () => {
    const { syncNow } = await syncedWorker();
    server.offline = true;
    vi.setSystemTime(START + 86_400_000);
    await syncNow();
    vi.setSystemTime(START);
    server.offline = false;
    await fireAlarm(CLOUD_SYNC_ALARM);
    expect(meta().failures).toBeUndefined();
  });
});

describe('what the server has and this device cannot read', () => {
  it('stays known after the next run, until a readable version arrives', async () => {
    await syncedWorker();
    const bad = { kind: 'session', id: 'far', updatedAt: START + 1, deleted: false } as const;
    server.inject({
      ...bad,
      iv: toBase64(new Uint8Array(12)),
      ciphertext: btoa('not a ciphertext'),
    });
    await fireAlarm(CLOUD_SYNC_ALARM);
    await fireAlarm(CLOUD_SYNC_ALARM);
    const { loadSyncFacts, syncPhase } = await import('@/lib/cloud-sync-status');
    expect(syncPhase(await loadSyncFacts(), Date.now())).toEqual({ kind: 'unreadable', count: 1 });

    const good = { ...bad, updatedAt: START + 2 };
    server.inject({ ...good, ...(await encryptRecord(rawKey, good, session('far', START + 2))) });
    await fireAlarm(CLOUD_SYNC_ALARM);
    expect(syncPhase(await loadSyncFacts(), Date.now()).kind).toBe('upToDate');
  });

  it('a session too large has its own status, without a next sync promised', async () => {
    const { sessionRepo } = await syncedWorker();
    const big = session('big');
    big.windows[0]!.tabs[0]!.title = 'x'.repeat(800_000);
    await sessionRepo.put(big);
    await settle();
    await pass(2500);
    await settle();
    const { loadSyncFacts, syncPhase } = await import('@/lib/cloud-sync-status');
    expect(syncPhase(await loadSyncFacts(), Date.now())).toEqual({ kind: 'tooLarge', count: 1 });
  });
});
