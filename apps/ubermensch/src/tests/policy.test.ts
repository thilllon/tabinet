import { describe, expect, it } from 'vitest';

import {
  DOCS_CONTENT_MATCHES,
  DOCS_ORIGINS,
  DRIVE_FILE_FIELDS,
  GOOGLE_OAUTH,
  POLICY,
} from '@/constants';

describe('POLICY', () => {
  it('pins every value, so a change is deliberate', () => {
    expect(POLICY).toEqual({
      cache: { fileTtlMs: 300_000, folderTtlMs: 600_000, driveTtlMs: 1_800_000 },
      path: { maxDepth: 25, maxChars: 64, maxSegmentChars: 32 },
      auth: { expiryMarginMs: 60_000 },
      request: { timeoutMs: 15_000 },
    });
  });

  it('a file lives shorter in the cache than the folders above it', () => {
    expect(POLICY.cache.fileTtlMs).toBeLessThan(POLICY.cache.folderTtlMs);
    expect(POLICY.cache.folderTtlMs).toBeLessThanOrEqual(POLICY.cache.driveTtlMs);
  });
});

describe('decided by the owner', () => {
  it('reads metadata only, with the one restricted scope', () => {
    expect(DRIVE_FILE_FIELDS).toBe('id,name,parents,driveId,owners(displayName),mimeType');
    expect(GOOGLE_OAUTH.scopes).toEqual([
      'https://www.googleapis.com/auth/drive.metadata.readonly',
    ]);
  });

  it('runs on the three editors of docs.google.com only', () => {
    expect(DOCS_ORIGINS).toEqual(['https://docs.google.com/*']);
    expect(
      DOCS_CONTENT_MATCHES.every((match) => match.startsWith('https://docs.google.com/')),
    ).toBe(true);
  });
});
