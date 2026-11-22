import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SyncOptions, SyncResult } from '@/lib/cloud-sync';
import { createSyncScheduler, debounceDelay } from '@/lib/cloud-sync-scheduler';

const RESULT: SyncResult = { outcome: 'synced', pulled: 0, pushed: 0 };

function setUp() {
  const runs: (SyncOptions | undefined)[] = [];
  const ends: (() => void)[] = [];
  const report = vi.fn<(err: unknown) => void>();
  const sync = (options?: SyncOptions) => {
    runs.push(options);
    return new Promise<SyncResult>((resolve) => ends.push(() => resolve(RESULT)));
  };
  return { runs, ends, report, scheduler: createSyncScheduler({ sync, report }) };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('debounceDelay', () => {
  it('waits 2.5 seconds, never past ten seconds from the first change', () => {
    expect(debounceDelay(0, 0)).toBe(2500);
    expect(debounceDelay(0, 7500)).toBe(2500);
    expect(debounceDelay(0, 9000)).toBe(1000);
    expect(debounceDelay(0, 12_000)).toBe(0);
  });
});

describe('createSyncScheduler', () => {
  it('runs at once for "now", which also settles a waiting timer', async () => {
    const { runs, ends, scheduler } = setUp();
    scheduler.trigger('soon');
    scheduler.trigger('now');
    expect(runs).toEqual([{}]);
    ends[0]();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(runs).toEqual([{}]);
  });

  it('keeps at most one run waiting, the strongest', async () => {
    const { runs, ends, scheduler } = setUp();
    scheduler.run('due');
    scheduler.run('changed');
    scheduler.run('always');
    scheduler.run('due');
    expect(runs).toHaveLength(1);
    ends[0]();
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toEqual([{ onlyIf: 'due' }, {}]);
    ends[1]();
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toHaveLength(2);
  });

  it('"stop" drops the timer and the waiting run', async () => {
    const { runs, ends, scheduler } = setUp();
    scheduler.run('due');
    scheduler.run('due');
    scheduler.trigger('soon');
    scheduler.trigger('stop');
    ends[0]();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(runs).toHaveLength(1);
  });

  it('reports a run that threw and keeps working', async () => {
    const report = vi.fn<(err: unknown) => void>();
    const sync = vi.fn<(options?: SyncOptions) => Promise<SyncResult>>();
    sync.mockRejectedValueOnce(new Error('boom')).mockResolvedValue(RESULT);
    const scheduler = createSyncScheduler({ sync, report });
    scheduler.run('due');
    await vi.advanceTimersByTimeAsync(0);
    scheduler.run('due');
    await vi.advanceTimersByTimeAsync(0);
    expect(report).toHaveBeenCalledOnce();
    expect(sync).toHaveBeenCalledTimes(2);
  });
});
