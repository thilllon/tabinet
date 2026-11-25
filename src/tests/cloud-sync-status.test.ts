import { afterEach, describe, expect, it, vi } from 'vitest';

import { SUPPORTED_LOCALES } from '@/constants';
import { CLOUD_SYNC_ALARM, CLOUD_SYNC_SOON_ALARM, SYNC_LOCK_NAME } from '@/lib/cloud-sync';
import { syncHelp } from '@/lib/cloud-sync-help';
import {
  loadSyncFacts,
  nextCheckAt,
  nextCheckText,
  nextCheckVariants,
  nextReadAt,
  NO_SYNC_FACTS,
  readingFor,
  sameFacts,
  syncPhase,
  syncPhaseText,
  syncPhaseVariants,
  type SyncFacts,
  whenSyncEnds,
  withoutPastTimes,
} from '@/lib/cloud-sync-status';
import { formatClockTime, formatDateTime } from '@/lib/display-format';
import { t } from '@/lib/i18n';

import { getChromeFake } from './chrome-fake';

const NOW = 1_800_000_000_000;
const SOON = NOW + 28_000;
const CHECK = NOW + 600_000;

function facts(overrides: Partial<SyncFacts> = {}): SyncFacts {
  return {
    ...NO_SYNC_FACTS,
    lastSyncAt: NOW - 60_000,
    lastAttemptAt: NOW - 60_000,
    checkAt: CHECK,
    ...overrides,
  };
}

/** A change made a second ago, its fallback alarm armed. */
const changed = { pending: true, changedAt: NOW - 1000, soonAt: SOON };

describe('syncPhase', () => {
  it('syncing wins over everything', () => {
    const all = { ...changed, running: true, failing: true, lastError: 'x', heldImages: 2 };
    expect(syncPhase(facts(all), NOW)).toEqual({ kind: 'syncing' });
  });

  it('failed says when the next try is: the earliest alarm', () => {
    const failing = { ...changed, failing: true, lastError: 'x' };
    expect(syncPhase(facts(failing), NOW)).toEqual({ kind: 'failed', at: SOON });
    expect(syncPhase(facts({ failing: true }), NOW)).toEqual({ kind: 'failed', at: CHECK });
    expect(syncPhase(facts({ failing: true, checkAt: null }), NOW)).toEqual({
      kind: 'failed',
      at: null,
    });
  });

  it('a fresh change is sent in a few seconds', () => {
    expect(syncPhase(facts(changed), NOW)).toEqual({ kind: 'sendingSoon' });
    expect(syncPhase(facts({ ...changed, lastError: 'x' }), NOW)).toEqual({ kind: 'sendingSoon' });
  });

  it('once the timer is overdue, only the alarm time is promised', () => {
    expect(syncPhase(facts(changed), NOW + 5000)).toEqual({ kind: 'waiting', at: SOON });
  });

  it('a change a finished run left behind is not promised in seconds', () => {
    const left = { pending: true, changedAt: NOW - 1000, lastAttemptAt: NOW - 500 };
    expect(syncPhase(facts(left), NOW)).toEqual({ kind: 'waiting', at: CHECK });
  });

  it('a run that left items out says so, with the next sync', () => {
    expect(syncPhase(facts({ lastError: 'x' }), NOW)).toEqual({ kind: 'partial', at: CHECK });
  });

  it('items over a limit are never called up to date', () => {
    expect(syncPhase(facts({ held: 3 }), NOW)).toEqual({
      kind: 'held',
      count: 3,
      at: NOW - 60_000,
    });
  });

  it('too large or unreadable has its own status: no next sync, never up to date', () => {
    const stuck = { pending: true, lastError: 'x' };
    expect(syncPhase(facts({ ...stuck, tooLarge: 2 }), NOW)).toEqual({
      kind: 'tooLarge',
      count: 2,
    });
    expect(syncPhase(facts({ unreadable: 1 }), NOW)).toEqual({ kind: 'unreadable', count: 1 });
    // Work a run can still do is said first, with its time.
    const more = facts({ ...stuck, tooLarge: 1, soonAt: SOON });
    expect(syncPhase(more, NOW)).toEqual({ kind: 'waiting', at: SOON });
  });

  it('failed names the retry, not a check that waits for it', () => {
    const late = facts({ failing: true, soonAt: CHECK + 60_000 });
    expect(syncPhase(late, NOW)).toEqual({ kind: 'failed', at: CHECK + 60_000 });
    expect(nextCheckAt(late)).toBe(CHECK + 60_000);
    expect(nextCheckAt({ ...late, running: true })).toBe(CHECK);
    expect(nextCheckAt(facts({ soonAt: SOON }))).toBe(CHECK);
  });

  it('up to date carries the last sync time', () => {
    expect(syncPhase(facts(), NOW)).toEqual({ kind: 'upToDate', at: NOW - 60_000 });
  });

  it('before the first sync nothing is claimed', () => {
    expect(syncPhase(NO_SYNC_FACTS, NOW)).toEqual({ kind: 'notSynced' });
  });
});

describe('reading again', () => {
  it('when the few seconds are over, then when the alarms pass', () => {
    expect(nextReadAt(facts(changed), NOW)).toBe(NOW + 3000);
    expect(nextReadAt(facts({ soonAt: SOON }), NOW)).toBe(SOON + 1000);
    expect(nextReadAt(facts(), NOW)).toBe(CHECK + 1000);
  });

  it('an overdue alarm is looked at again later, never at a time already past', () => {
    expect(nextReadAt(facts({ soonAt: NOW - 5000, checkAt: NOW - 5000 }), NOW)).toBe(NOW + 30_000);
    expect(nextReadAt(facts({ soonAt: null, checkAt: null }), NOW)).toBeNull();
  });

  it('an overdue alarm is not shown as a time to come', () => {
    const late = withoutPastTimes(facts({ failing: true, soonAt: NOW - 1, checkAt: NOW }), NOW);
    expect(syncPhase(late, NOW)).toEqual({ kind: 'failed', at: null });
    expect(nextCheckAt(late)).toBeNull();
    expect(withoutPastTimes(facts({ soonAt: SOON }), NOW).soonAt).toBe(SOON);
  });

  it('a reading is shown only for the account it was read for', () => {
    const reading = { of: 'tok-a', facts: facts(), phase: syncPhase(facts(), NOW), loaded: true };
    expect(readingFor(reading, 'tok-a')).toBe(reading);
    for (const account of ['tok-b', undefined]) {
      expect(readingFor(reading, account)).toMatchObject({ loaded: false, facts: NO_SYNC_FACTS });
    }
  });

  it('an unchanged reading is the same', () => {
    expect(sameFacts(facts(), facts())).toBe(true);
    expect(sameFacts(facts(), facts({ pending: true }))).toBe(false);
  });
});

describe('the text', () => {
  afterEach(() => {
    getChromeFake().setUiLanguage('en');
  });

  it('every status, in English', () => {
    const at = formatClockTime(SOON, 'seconds');
    const day = formatDateTime(NOW);
    expect(syncPhaseVariants(facts()).slice(0, 1)).toEqual(['Syncing now...']);
    expect(syncPhaseText({ kind: 'tooLarge', count: 1 })).toBe(
      '1 item is too large to sync and stays on this device.',
    );
    expect(syncPhaseText({ kind: 'unreadable', count: 2 })).toBe(
      '2 items from the cloud could not be read here and were skipped.',
    );
    expect(syncPhaseText({ kind: 'failed', at: SOON })).toBe(
      `Sync failed. It will try again at ${at}.`,
    );
    expect(syncPhaseText({ kind: 'failed', at: null })).toBe('Sync failed. It will try again.');
    expect(syncPhaseText({ kind: 'sendingSoon' })).toBe(
      'Changes waiting. They will be sent in a few seconds.',
    );
    expect(syncPhaseText({ kind: 'waiting', at: SOON })).toBe(
      `Changes waiting. They will be sent at ${at}.`,
    );
    expect(syncPhaseText({ kind: 'partial', at: SOON })).toBe(
      `Some items did not sync. Next sync at ${at}.`,
    );
    expect(syncPhaseText({ kind: 'held', count: 1, at: NOW })).toBe(
      `Synced ${day}, except 1 item over a limit.`,
    );
    expect(syncPhaseText({ kind: 'upToDate', at: NOW })).toBe(`Up to date. Last synced ${day}.`);
    expect(syncPhaseText({ kind: 'notSynced' })).toBe('Not synced yet.');
  });

  it('room is kept for the widest time, not for the one shown', () => {
    // The case that moved the row: last synced at 1:11:11, the next sync at 22:58:58.
    const shown = facts({ lastSyncAt: new Date(2026, 10, 23, 1, 11, 11).getTime() });
    for (const hour of [10, 22]) {
      const wide = new Date(2028, 10, 28, hour, 58, 58).getTime();
      for (const kind of ['failed', 'partial', 'waiting', 'upToDate'] as const) {
        expect(syncPhaseVariants(shown)).toContain(syncPhaseText({ kind, at: wide }));
      }
      expect(nextCheckVariants()).toContain(nextCheckText(wide));
    }
  });

  it('the help says only loading the page syncs', () => {
    const now = syncHelp().sections[2]?.points.join(' ');
    expect(now).toContain('switching to a Tabinet tab that is already open does not');
  });

  it('the next check shows its time and the 15 minutes', () => {
    expect(nextCheckText(CHECK)).toBe(
      `Next check for changes from other devices: ${formatClockTime(CHECK)} (every 15 minutes)`,
    );
    expect(nextCheckText(null)).toContain('every 15 minutes');
  });

  it.each(SUPPORTED_LOCALES)('is complete in %s, the help with its real numbers', (locale) => {
    getChromeFake().setUiLanguage(locale);
    for (const text of syncPhaseVariants(facts())) {
      expect(text).not.toBe('');
      expect(text).not.toMatch(/\$\d/);
    }
    const { intro, sections } = syncHelp();
    const all = [intro, ...sections.flatMap(({ title, points }) => [title, ...points])];
    for (const text of all) {
      expect(text).not.toBe('');
      expect(text).not.toMatch(/\$\d/);
    }
    for (const number of ['10', '15', '30', '100', '768']) {
      expect(all.join(' ')).toContain(number);
    }
    // Buttons and settings are quoted by their own labels.
    for (const key of ['settingsAccountSyncNow', 'settingsYoutubeAccess', 'sessionKeep'] as const) {
      expect(all.join(' ')).toContain(t(key));
    }
  });
});

describe('loadSyncFacts', () => {
  it('reads the real alarm times', async () => {
    await chrome.alarms.create(CLOUD_SYNC_SOON_ALARM, { when: SOON });
    await chrome.alarms.create(CLOUD_SYNC_ALARM, { when: CHECK });
    expect(await loadSyncFacts()).toMatchObject({ soonAt: SOON, checkAt: CHECK, running: false });
  });

  it('a run that ends while it is being read is syncing, not failed', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ held: [{ name: SYNC_LOCK_NAME, mode: 'exclusive' }] })
      .mockResolvedValue({ held: [] });
    vi.stubGlobal('navigator', { locks: { query } });
    expect((await loadSyncFacts()).running).toBe(true);
    vi.unstubAllGlobals();
  });

  it('syncing is the lock being held, and ends when it is let go', async () => {
    let release = () => {};
    let acquired = () => {};
    const isHeld = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const run = navigator.locks.request(SYNC_LOCK_NAME, async () => {
      acquired();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await isHeld;
    expect((await loadSyncFacts()).running).toBe(true);
    const ended = whenSyncEnds(new AbortController().signal);
    release();
    await Promise.all([run, ended]);
    expect((await loadSyncFacts()).running).toBe(false);
  });
});
