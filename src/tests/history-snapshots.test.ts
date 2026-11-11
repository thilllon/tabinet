import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  defaultHistoryName,
  ensureHistoryAlarm,
  HISTORY_ALARM,
  HISTORY_FIRST_ALARM,
  type HistorySnapshotResult,
  promoteRecoveredSnapshot,
  recoveredSnapshotName,
  scheduleFirstSnapshot,
  takeHistorySnapshot,
} from '@/lib/history-snapshots';
import { applyUiLanguage } from '@/lib/i18n';
import { INDEX_KEY, SETTINGS_KEY, sessionRepo } from '@/lib/session-repo';
import { SESSION_SCHEMA_VERSION, type Session, type WindowSnapshot } from '@/types';

import { getChromeFake, readLocaleFile } from './chrome-fake';

// Local time 2026-08-29 14:03 so generated names are deterministic.
const NOW = new Date(2026, 7, 29, 14, 3).getTime();
const MINUTE = 60_000;

async function seedWindow(urls: string[]): Promise<number> {
  const win = await chrome.windows.create({ url: urls[0] });
  if (win === undefined || win.id === undefined) {
    throw new Error('fake windows.create returned nothing');
  }
  for (const url of urls.slice(1)) {
    await chrome.tabs.create({ windowId: win.id, url, active: false });
  }
  return win.id;
}

function makeWindow(urls: string[]): WindowSnapshot {
  return {
    state: 'normal',
    focused: false,
    groups: [],
    tabs: urls.map((url, index) => ({ url, title: url, pinned: false, active: index === 0 })),
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    id: 'id',
    kind: 'history',
    name: 'Snapshot',
    origin: 'alarm',
    createdAt: NOW,
    updatedAt: NOW,
    windows: [makeWindow(['https://a.com/'])],
    ...overrides,
  };
}

/** Protects a snapshot without the crash-recovery marker (older versions stored such pins). */
async function protect(id: string): Promise<void> {
  await sessionRepo.update(id, (session) => {
    const next: Session = { ...session, protected: true };
    delete next.autoProtected;
    return next;
  });
}

function storedSessionIds(): string[] {
  return [...getChromeFake().state.local.keys()]
    .filter((key) => key.startsWith('session:'))
    .map((key) => key.slice('session:'.length));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('names', () => {
  it('defaultHistoryName mirrors defaultSessionName with the Snapshot noun', () => {
    expect(defaultHistoryName(new Date(2026, 7, 29, 14, 3), 3, 87)).toBe(
      'Snapshot 2026-08-29 14:03 · 3 windows · 87 tabs',
    );
    expect(defaultHistoryName(new Date(2026, 0, 5, 9, 7), 1, 1)).toBe(
      'Snapshot 2026-01-05 09:07 · 1 window · 1 tab',
    );
  });

  it('recoveredSnapshotName stamps the capture time', () => {
    expect(recoveredSnapshotName(new Date(2026, 11, 31, 23, 59))).toBe(
      'Previous session (recovered) 2026-12-31 23:59',
    );
  });
});

describe('takeHistorySnapshot', () => {
  it("returns 'disabled' and touches neither windows nor storage when history is off", async () => {
    await sessionRepo.setSettings({ historyEnabled: false });
    await seedWindow(['https://a.com/']);
    const getAllSpy = vi.spyOn(chrome.windows, 'getAll');

    await expect(takeHistorySnapshot({ origin: 'alarm' })).resolves.toEqual({
      outcome: 'disabled',
      pruned: [],
    });

    expect(getAllSpy).not.toHaveBeenCalled();
    expect(storedSessionIds()).toEqual([]);
    await expect(sessionRepo.getHistoryMeta()).resolves.toBeUndefined();
  });

  it("returns 'skipped-empty' when nothing is capturable (only empty/own-page windows)", async () => {
    await seedWindow([chrome.runtime.getURL('app.html')]);

    await expect(takeHistorySnapshot({ origin: 'alarm' })).resolves.toEqual({
      outcome: 'skipped-empty',
      pruned: [],
    });

    expect(storedSessionIds()).toEqual([]);
    expect(getChromeFake().state.local.has(INDEX_KEY)).toBe(false);
    await expect(sessionRepo.getHistoryMeta()).resolves.toBeUndefined();
  });

  it('stores a history session with the origin, a Snapshot name and a hash, then writes historyMeta', async () => {
    await seedWindow(['https://a.com/', 'https://b.com/']);
    await seedWindow(['https://c.com/']);

    const result = await takeHistorySnapshot({ origin: 'alarm' });

    expect(result.outcome).toBe('saved');
    expect(result.pruned).toEqual([]);
    expect(result.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    const body = await sessionRepo.get(result.sessionId ?? '');
    expect(body).toMatchObject({
      kind: 'history',
      origin: 'alarm',
      name: 'Snapshot 2026-08-29 14:03 · 2 windows · 3 tabs',
      createdAt: NOW,
    });
    expect(body?.protected).toBeUndefined();
    expect(body?.contentHash).toMatch(/^[0-9a-f]{8}$/);
    const summaries = await sessionRepo.listSummaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ kind: 'history', windowCount: 2, tabCount: 3 });
    await expect(sessionRepo.getHistoryMeta()).resolves.toEqual({
      lastHash: body?.contentHash,
      lastSnapshotAt: NOW,
    });
  });

  it("passes 'manual' and 'startup' origins through", async () => {
    const winId = await seedWindow(['https://a.com/']);

    const manual = await takeHistorySnapshot({ origin: 'manual' });
    await chrome.tabs.create({ windowId: winId, url: 'https://b.com/', active: false });
    const startup = await takeHistorySnapshot({ origin: 'startup' });

    expect((await sessionRepo.get(manual.sessionId ?? ''))?.origin).toBe('manual');
    expect((await sessionRepo.get(startup.sessionId ?? ''))?.origin).toBe('startup');
  });

  it("skips an identical layout with 'skipped-unchanged' and leaves storage alone", async () => {
    await seedWindow(['https://a.com/', 'https://b.com/']);
    const first = await takeHistorySnapshot({ origin: 'alarm' });
    const metaBefore = await sessionRepo.getHistoryMeta();
    vi.setSystemTime(NOW + 5 * MINUTE);
    const setSpy = vi.spyOn(chrome.storage.local, 'set');

    const second = await takeHistorySnapshot({ origin: 'alarm' });

    expect(first.outcome).toBe('saved');
    expect(second).toEqual({ outcome: 'skipped-unchanged', pruned: [] });
    expect(setSpy).not.toHaveBeenCalled();
    expect(storedSessionIds()).toEqual([first.sessionId]);
    await expect(sessionRepo.getHistoryMeta()).resolves.toEqual(metaBefore);
  });

  it('a title-only change is still unchanged (titles are excluded from the hash)', async () => {
    const winId = await seedWindow(['https://a.com/']);
    await takeHistorySnapshot({ origin: 'alarm' });
    const tab = [...getChromeFake().state.tabs.values()].find((t) => t.windowId === winId);
    if (tab === undefined) {
      throw new Error('seeded tab missing');
    }
    tab.title = 'A brand new title';

    await expect(takeHistorySnapshot({ origin: 'alarm' })).resolves.toMatchObject({
      outcome: 'skipped-unchanged',
    });
  });

  it('stores a new snapshot after the layout changed and advances historyMeta', async () => {
    const winId = await seedWindow(['https://a.com/']);
    const first = await takeHistorySnapshot({ origin: 'alarm' });
    await chrome.tabs.create({ windowId: winId, url: 'https://b.com/', active: false });
    vi.setSystemTime(NOW + 5 * MINUTE);

    const second = await takeHistorySnapshot({ origin: 'alarm' });

    expect(second.outcome).toBe('saved');
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(storedSessionIds().sort()).toEqual([first.sessionId, second.sessionId].sort());
    const meta = await sessionRepo.getHistoryMeta();
    expect(meta?.lastSnapshotAt).toBe(NOW + 5 * MINUTE);
    expect(meta?.lastHash).toBe((await sessionRepo.get(second.sessionId ?? ''))?.contentHash);
    expect(meta?.lastHash).not.toBe((await sessionRepo.get(first.sessionId ?? ''))?.contentHash);
  });

  it('honours the ring size: prunes the oldest unprotected snapshots beyond historyMaxSnapshots', async () => {
    await sessionRepo.setSettings({ historyMaxSnapshots: 2 });
    const winId = await seedWindow(['https://a.com/']);
    const ids: string[] = [];
    const results: HistorySnapshotResult[] = [];
    for (const [step, url] of ['https://b.com/', 'https://c.com/', 'https://d.com/'].entries()) {
      vi.setSystemTime(NOW + step * MINUTE);
      const result = await takeHistorySnapshot({ origin: 'alarm' });
      results.push(result);
      ids.push(result.sessionId ?? '');
      await chrome.tabs.create({ windowId: winId, url, active: false });
    }
    vi.setSystemTime(NOW + 3 * MINUTE);

    const fourth = await takeHistorySnapshot({ origin: 'alarm' });

    expect(results.map((r) => r.pruned)).toEqual([[], [], [ids[0]]]);
    expect(fourth.pruned).toEqual([ids[1]]);
    expect(storedSessionIds().sort()).toEqual([ids[2], fourth.sessionId].sort());
    expect((await sessionRepo.listSummaries()).map((s) => s.id)).toEqual([
      fourth.sessionId,
      ids[2],
    ]);
  });

  it('pruning never touches saved sessions or protected snapshots', async () => {
    await sessionRepo.setSettings({ historyMaxSnapshots: 1 });
    await sessionRepo.put(
      makeSession({ id: 'saved-old', kind: 'saved', origin: 'manual', createdAt: 1 }),
    );
    await sessionRepo.put(makeSession({ id: 'protected-old', protected: true, createdAt: 2 }));
    await sessionRepo.put(makeSession({ id: 'recovered-old', origin: 'recovered', createdAt: 3 }));
    await protect('recovered-old');
    const winId = await seedWindow(['https://a.com/']);

    const first = await takeHistorySnapshot({ origin: 'alarm' });
    await chrome.tabs.create({ windowId: winId, url: 'https://b.com/', active: false });
    vi.setSystemTime(NOW + MINUTE);
    const second = await takeHistorySnapshot({ origin: 'alarm' });

    expect(first.pruned).toEqual([]);
    expect(second.pruned).toEqual([first.sessionId]);
    expect(storedSessionIds().sort()).toEqual(
      ['saved-old', 'protected-old', 'recovered-old', second.sessionId].sort(),
    );
  });

  it('propagates a storage failure and leaves historyMeta untouched', async () => {
    await seedWindow(['https://a.com/']);
    getChromeFake().failNext('storage.local.set', 1, 'QUOTA_BYTES exceeded');

    await expect(takeHistorySnapshot({ origin: 'alarm' })).rejects.toThrow('QUOTA_BYTES exceeded');

    expect(storedSessionIds()).toEqual([]);
    await expect(sessionRepo.getHistoryMeta()).resolves.toBeUndefined();
  });
});

describe('promoteRecoveredSnapshot', () => {
  it('returns null when there is no history', async () => {
    await sessionRepo.put(makeSession({ id: 'saved', kind: 'saved', origin: 'manual' }));

    await expect(promoteRecoveredSnapshot()).resolves.toBeNull();

    expect((await sessionRepo.get('saved'))?.origin).toBe('manual');
  });

  it('promotes the newest unprotected alarm snapshot: origin, protected flag and name', async () => {
    await sessionRepo.put(makeSession({ id: 'older', createdAt: NOW - 10 * MINUTE }));
    await sessionRepo.put(makeSession({ id: 'newest', createdAt: NOW - 5 * MINUTE }));
    vi.setSystemTime(NOW + 30 * MINUTE);

    await expect(promoteRecoveredSnapshot()).resolves.toBe('newest');

    const body = await sessionRepo.get('newest');
    expect(body).toMatchObject({
      origin: 'recovered',
      protected: true,
      name: 'Previous session (recovered) 2026-08-29 13:58',
      updatedAt: NOW,
    });
    const summaries = await sessionRepo.listSummaries();
    expect(summaries.find((s) => s.id === 'newest')).toMatchObject({
      origin: 'recovered',
      protected: true,
      name: 'Previous session (recovered) 2026-08-29 13:58',
    });
    expect(await sessionRepo.get('older')).toMatchObject({ origin: 'alarm', name: 'Snapshot' });
  });

  it('is idempotent: a second startup with nothing new promotes nothing', async () => {
    await sessionRepo.put(makeSession({ id: 'older', createdAt: NOW - 10 * MINUTE }));
    await sessionRepo.put(makeSession({ id: 'newest', createdAt: NOW - 5 * MINUTE }));
    await promoteRecoveredSnapshot();

    await expect(promoteRecoveredSnapshot()).resolves.toBeNull();

    const summaries = await sessionRepo.listSummaries();
    expect(summaries.filter((s) => s.origin === 'recovered').map((s) => s.id)).toEqual(['newest']);
    expect((await sessionRepo.get('older'))?.origin).toBe('alarm');
  });

  it('promotes a snapshot captured after the existing recovered one (a later crash)', async () => {
    await sessionRepo.put(
      makeSession({ id: 'first-crash', origin: 'recovered', protected: true, createdAt: NOW }),
    );
    await sessionRepo.put(makeSession({ id: 'later', createdAt: NOW + 20 * MINUTE }));

    await expect(promoteRecoveredSnapshot()).resolves.toBe('later');

    expect((await sessionRepo.get('later'))?.origin).toBe('recovered');
    expect((await sessionRepo.get('first-crash'))?.origin).toBe('recovered');
  });

  it('ignores saved sessions, protected snapshots and imported/recovered origins', async () => {
    await sessionRepo.put(
      makeSession({ id: 'saved', kind: 'saved', origin: 'manual', createdAt: NOW + 4 * MINUTE }),
    );
    await sessionRepo.put(
      makeSession({ id: 'pinned', protected: true, createdAt: NOW + 3 * MINUTE }),
    );
    await sessionRepo.put(makeSession({ id: 'imported', origin: 'import', createdAt: NOW + 2 }));
    await sessionRepo.put(makeSession({ id: 'manual', origin: 'manual', createdAt: NOW + 1 }));
    await sessionRepo.put(makeSession({ id: 'startup', origin: 'startup', createdAt: NOW }));

    await expect(promoteRecoveredSnapshot()).resolves.toBe('manual');

    const origins = Object.fromEntries(
      (await sessionRepo.listSummaries()).map((s) => [s.id, s.origin]),
    );
    expect(origins).toEqual({
      saved: 'manual',
      pinned: 'alarm',
      imported: 'import',
      manual: 'recovered',
      startup: 'startup',
    });
  });

  it('keeps the pins bounded across ten browser starts, demoting the older recovered ones', async () => {
    const promoted: (string | null)[] = [];
    for (let start = 1; start <= 10; start += 1) {
      // Each start: a snapshot arrived since the last one, then Chrome restarts.
      vi.setSystemTime(NOW + start * MINUTE);
      await sessionRepo.put(makeSession({ id: `s${start}`, createdAt: NOW + start * MINUTE }));
      promoted.push(await promoteRecoveredSnapshot());
      // The snapshot this start promoted is always protected while it is the newest.
      const pin = (await sessionRepo.listSummaries()).find((s) => s.id === `s${start}`);
      expect(pin).toMatchObject({ origin: 'recovered', protected: true });
    }

    expect(promoted).toEqual(['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10']);
    const summaries = await sessionRepo.listSummaries();
    // Demoted, never deleted: all ten are still there and still say "recovered".
    expect(summaries.filter((s) => s.origin === 'recovered')).toHaveLength(10);
    expect(summaries.filter((s) => s.protected === true).map((s) => s.id)).toEqual(['s10', 's9']);
    expect(summaries.filter((s) => s.autoProtected === true).map((s) => s.id)).toEqual([
      's10',
      's9',
    ]);
    // And the demoted ones are back in the ring buffer's reach.
    await expect(sessionRepo.pruneHistory(3)).resolves.toEqual(['s1', 's2', 's3', 's4', 's5']);
  });

  it('never demotes a snapshot protected without the marker', async () => {
    await sessionRepo.put(makeSession({ id: 'user-pin', createdAt: NOW }));
    await protect('user-pin');
    vi.setSystemTime(NOW + MINUTE);
    await sessionRepo.put(makeSession({ id: 'taken-over', createdAt: NOW + MINUTE }));
    await promoteRecoveredSnapshot();
    // A protected snapshot without the marker stops being crash recovery's to demote, even
    // though it was promoted first.
    await protect('taken-over');

    for (let start = 2; start <= 11; start += 1) {
      vi.setSystemTime(NOW + start * MINUTE);
      await sessionRepo.put(makeSession({ id: `s${start}`, createdAt: NOW + start * MINUTE }));
      await promoteRecoveredSnapshot();
    }

    const summaries = await sessionRepo.listSummaries();
    const stillPinned = summaries.filter((s) => s.protected === true).map((s) => s.id);
    expect(stillPinned).toContain('user-pin');
    expect(stillPinned).toContain('taken-over');
    // Plus the two newest auto-pins, and nothing else.
    expect(stillPinned.sort()).toEqual(['s10', 's11', 'taken-over', 'user-pin']);
    await expect(sessionRepo.pruneHistory(0)).resolves.not.toContain('user-pin');
  });

  it('never promotes across untouched restarts when history is off (ring does not fill with protected entries)', async () => {
    await sessionRepo.setSettings({ historyEnabled: false });
    await sessionRepo.put(makeSession({ id: 's1', createdAt: NOW - 3 * MINUTE }));
    await sessionRepo.put(makeSession({ id: 's2', createdAt: NOW - 2 * MINUTE }));
    await sessionRepo.put(makeSession({ id: 's3', createdAt: NOW - MINUTE }));

    const promoted = [
      await promoteRecoveredSnapshot(),
      await promoteRecoveredSnapshot(),
      await promoteRecoveredSnapshot(),
    ];

    expect(promoted).toEqual(['s3', null, null]);
    const protectedIds = (await sessionRepo.listSummaries())
      .filter((s) => s.protected === true)
      .map((s) => s.id);
    expect(protectedIds).toEqual(['s3']);
  });
});

describe('ensureHistoryAlarm', () => {
  it('creates the periodic alarm from stored settings (default 5 min)', async () => {
    await ensureHistoryAlarm();

    const alarms = await chrome.alarms.getAll();
    expect(alarms).toHaveLength(1);
    expect(alarms[0]).toMatchObject({ name: HISTORY_ALARM, periodInMinutes: 5 });
  });

  it('uses the given settings without reading them from storage', async () => {
    await sessionRepo.setSettings({ historyEnabled: false });
    const getSpy = vi.spyOn(chrome.storage.local, 'get');

    await ensureHistoryAlarm({
      historyEnabled: true,
      historyIntervalMinutes: 30,
      historyMaxSnapshots: 20,
      restoreLazy: 'auto',
    });

    const keysRead = getSpy.mock.calls.flatMap(([keys]) => (Array.isArray(keys) ? keys : [keys]));
    expect(keysRead).not.toContain(SETTINGS_KEY);
    expect(getChromeFake().state.alarms.get(HISTORY_ALARM)).toEqual({ periodInMinutes: 30 });
  });

  it('leaves a running alarm with the same interval alone, so its countdown is not restarted', async () => {
    await chrome.alarms.create(HISTORY_ALARM, { periodInMinutes: 1440, when: 123_456 });
    await sessionRepo.setSettings({ historyIntervalMinutes: 1440 });

    await ensureHistoryAlarm();

    expect(getChromeFake().state.alarms.get(HISTORY_ALARM)).toEqual({
      periodInMinutes: 1440,
      when: 123_456,
    });
  });

  it('times a new alarm from the last snapshot rather than from now', async () => {
    const lastSnapshotAt = Date.now() - 10 * 60_000;
    await sessionRepo.setHistoryMeta({ lastHash: 'h', lastSnapshotAt });
    await sessionRepo.setSettings({ historyIntervalMinutes: 60 });

    await ensureHistoryAlarm();

    expect(getChromeFake().state.alarms.get(HISTORY_ALARM)).toEqual({
      periodInMinutes: 60,
      when: lastSnapshotAt + 60 * 60_000,
    });
  });

  it('fires a new alarm at once when the last snapshot is already older than the interval', async () => {
    await sessionRepo.setHistoryMeta({ lastHash: 'h', lastSnapshotAt: Date.now() - 3 * 3_600_000 });
    await sessionRepo.setSettings({ historyIntervalMinutes: 60 });
    const before = Date.now();

    await ensureHistoryAlarm();

    const when = getChromeFake().state.alarms.get(HISTORY_ALARM)?.when ?? 0;
    expect(when).toBeGreaterThanOrEqual(before);
    expect(when).toBeLessThanOrEqual(Date.now());
  });

  it('replaces an existing alarm when the interval changes (no duplicate)', async () => {
    await sessionRepo.setSettings({ historyIntervalMinutes: 10 });
    await ensureHistoryAlarm();
    await sessionRepo.setSettings({ historyIntervalMinutes: 30 });

    await ensureHistoryAlarm();

    const alarms = await chrome.alarms.getAll();
    expect(alarms).toHaveLength(1);
    expect(alarms[0]).toMatchObject({ name: HISTORY_ALARM, periodInMinutes: 30 });
  });

  it('clears both alarms when history is disabled and leaves other alarms alone', async () => {
    await ensureHistoryAlarm();
    await scheduleFirstSnapshot();
    await chrome.alarms.create('unrelated', { delayInMinutes: 3 });
    await sessionRepo.setSettings({ historyEnabled: false });

    await ensureHistoryAlarm();

    expect([...getChromeFake().state.alarms.keys()]).toEqual(['unrelated']);
  });
});

describe('scheduleFirstSnapshot', () => {
  it('arms a one-shot history-first alarm 1 minute out when history is on', async () => {
    await scheduleFirstSnapshot();

    const alarms = await chrome.alarms.getAll();
    expect(alarms).toHaveLength(1);
    expect(alarms[0].name).toBe(HISTORY_FIRST_ALARM);
    expect(alarms[0].periodInMinutes).toBeUndefined();
    expect(alarms[0].scheduledTime).toBe(NOW + MINUTE);
    expect(getChromeFake().state.alarms.get(HISTORY_FIRST_ALARM)).toEqual({ delayInMinutes: 1 });
  });

  it('does nothing when history is off', async () => {
    await sessionRepo.setSettings({ historyEnabled: false });

    await scheduleFirstSnapshot();

    await expect(chrome.alarms.getAll()).resolves.toEqual([]);
  });

  it('honours explicitly passed settings', async () => {
    await scheduleFirstSnapshot({
      historyEnabled: false,
      historyIntervalMinutes: 5,
      historyMaxSnapshots: 20,
      restoreLazy: 'auto',
    });

    await expect(chrome.alarms.getAll()).resolves.toEqual([]);
  });
});

describe('the language chosen in Settings', () => {
  afterEach(async () => {
    await applyUiLanguage('auto');
  });

  it('names a snapshot in that language, waiting for it to load', async () => {
    await seedWindow(['https://a.example/']);
    const english = defaultHistoryName(new Date(NOW), 1, 1);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // A worker just woken by the alarm: the chosen language's files are still being read.
    void applyUiLanguage('ja', async (locale) => {
      await gate;
      return readLocaleFile(locale);
    });
    const getAll = vi.spyOn(chrome.windows, 'getAll');

    const snapshot = takeHistorySnapshot({ origin: 'alarm' });
    // The capture is done and the snapshot is only waiting for its name: nothing may be stored
    // yet, or it would have been named in Chrome's language.
    await vi.waitFor(() => {
      expect(getAll).toHaveBeenCalled();
    });
    for (let turn = 0; turn < 50; turn++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(storedSessionIds()).toEqual([]);

    release();
    const result = await snapshot;

    const stored = await sessionRepo.get(result.sessionId ?? '');
    expect(stored?.name).not.toBe(english);
    // What Chrome itself would have named it in a Japanese browser.
    getChromeFake().setUiLanguage('ja');
    await applyUiLanguage('auto');
    expect(stored?.name).toBe(defaultHistoryName(new Date(NOW), 1, 1));
  });
});
