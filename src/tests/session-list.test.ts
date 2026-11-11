import { describe, expect, it } from 'vitest';

import { recoveredSnapshot, splitByKind } from '@/lib/session-list';
import type { SessionSummary } from '@/types';

function makeSummary(
  overrides: Partial<SessionSummary> & Pick<SessionSummary, 'id'>,
): SessionSummary {
  return {
    kind: 'history',
    name: 'Snapshot',
    origin: 'alarm',
    createdAt: 1000,
    updatedAt: 1000,
    windowCount: 1,
    tabCount: 3,
    bytes: 100,
    ...overrides,
  };
}

describe('splitByKind', () => {
  it('separates saved sessions from history snapshots', () => {
    const saved = makeSummary({ id: 's1', kind: 'saved', origin: 'manual' });
    const snapshot = makeSummary({ id: 'h1' });
    const result = splitByKind([saved, snapshot]);
    expect(result.saved).toEqual([saved]);
    expect(result.history).toEqual([snapshot]);
  });

  it('preserves the order of the index within each list', () => {
    const list = [
      makeSummary({ id: 'h2', createdAt: 3000, updatedAt: 3000 }),
      makeSummary({ id: 's1', kind: 'saved', origin: 'manual', updatedAt: 2000 }),
      makeSummary({ id: 'h1', createdAt: 1000, updatedAt: 1000 }),
      makeSummary({ id: 's2', kind: 'saved', origin: 'import', updatedAt: 500 }),
    ];
    expect(splitByKind(list).history.map((summary) => summary.id)).toEqual(['h2', 'h1']);
    expect(splitByKind(list).saved.map((summary) => summary.id)).toEqual(['s1', 's2']);
  });

  it('returns two empty lists for an empty index', () => {
    expect(splitByKind([])).toEqual({ saved: [], history: [] });
  });
});

describe('recoveredSnapshot', () => {
  const recovered = makeSummary({
    id: 'r1',
    origin: 'recovered',
    protected: true,
    createdAt: 5000,
    updatedAt: 5000,
    name: 'Previous session (recovered) 2026-08-29 14:03',
  });

  it('returns the newest snapshot when it is the recovered one', () => {
    const older = makeSummary({ id: 'h1', createdAt: 1000, updatedAt: 1000 });
    expect(recoveredSnapshot([recovered, older])).toEqual(recovered);
  });

  it('ignores the order it is given', () => {
    const older = makeSummary({ id: 'h1', createdAt: 1000, updatedAt: 1000 });
    expect(recoveredSnapshot([older, recovered])).toEqual(recovered);
  });

  it('does not show once a newer ordinary snapshot exists', () => {
    const newer = makeSummary({ id: 'h9', createdAt: 9000, updatedAt: 9000 });
    expect(recoveredSnapshot([recovered, newer])).toBeUndefined();
  });

  it('does not show without history snapshots', () => {
    expect(recoveredSnapshot([])).toBeUndefined();
  });
});
