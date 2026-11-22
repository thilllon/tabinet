import { afterEach, describe, expect, it } from 'vitest';

import { SUPPORTED_LOCALES } from '@/constants';
import { CLOUD_SYNC_ALARM, CLOUD_SYNC_SOON_ALARM, SYNC_LOCK_NAME } from '@/lib/cloud-sync';
import { syncHelp } from '@/lib/cloud-sync-help';
import {
  loadSyncFacts,
  nextCheckText,
  nextReadAt,
  NO_SYNC_FACTS,
  sameFacts,
  syncPhase,
  syncPhaseText,
  syncPhaseVariants,
  type SyncFacts,
  whenSyncEnds,
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

  it('screenshots over the limit are never called up to date', () => {
    expect(syncPhase(facts({ heldImages: 3 }), NOW)).toEqual({
      kind: 'held',
      count: 3,
      at: NOW - 60_000,
    });
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

  it('never at a time already past', () => {
    expect(nextReadAt(facts({ soonAt: NOW - 5000, checkAt: NOW - 5000 }), NOW)).toBeNull();
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
    expect(syncPhaseVariants(NOW, 2).slice(0, 1)).toEqual(['Syncing now...']);
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
      `Synced ${day}, except 1 screenshot over the limit.`,
    );
    expect(syncPhaseText({ kind: 'upToDate', at: NOW })).toBe(`Up to date. Last synced ${day}.`);
    expect(syncPhaseText({ kind: 'notSynced' })).toBe('Not synced yet.');
  });

  it('the next check shows its time and the 15 minutes', () => {
    expect(nextCheckText(CHECK)).toBe(
      `Next check for changes from other devices: ${formatClockTime(CHECK)} (every 15 minutes)`,
    );
    expect(nextCheckText(null)).toContain('every 15 minutes');
  });

  it.each(SUPPORTED_LOCALES)('is complete in %s, the help with its real numbers', (locale) => {
    getChromeFake().setUiLanguage(locale);
    for (const text of syncPhaseVariants(NOW, 2)) {
      expect(text).not.toBe('');
      expect(text).not.toMatch(/\$\d/);
    }
    const { intro, sections } = syncHelp();
    const all = [intro, ...sections.flatMap(({ title, points }) => [title, ...points])];
    for (const text of all) {
      expect(text).not.toBe('');
      expect(text).not.toMatch(/\$\d/);
    }
    for (const number of ['10', '15', '30', '100']) {
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
