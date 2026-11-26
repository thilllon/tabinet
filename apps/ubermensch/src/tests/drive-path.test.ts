import { describe, expect, it } from 'vitest';

import { POLICY } from '@/constants';
import { type PathDeps, resolvePath } from '@/lib/drive-path';
import type { DriveFile } from '@/types';

function deps(
  files: DriveFile[],
  options: { root?: string; drives?: Record<string, string> } = {},
): PathDeps & { asked: string[] } {
  const byId = new Map(files.map((file) => [file.id, file]));
  const asked: string[] = [];
  return {
    asked,
    getFile: async (id) => {
      asked.push(id);
      return byId.get(id);
    },
    getDriveName: async (id) => options.drives?.[id],
    getRootId: async () => options.root ?? 'root',
  };
}

describe('resolvePath', () => {
  it('walks a My Drive file up to the root', async () => {
    const path = await resolvePath(
      'doc',
      deps([
        { id: 'doc', name: 'Plan', parents: ['f2'] },
        { id: 'f2', name: '2026', parents: ['f1'] },
        { id: 'f1', name: 'Projects', parents: ['root'] },
        { id: 'root', name: 'My Drive' },
      ]),
    );
    expect(path).toEqual({
      kind: 'path',
      partial: false,
      segments: [
        { id: 'root', name: 'My Drive', kind: 'my-drive' },
        { id: 'f1', name: 'Projects', kind: 'folder' },
        { id: 'f2', name: '2026', kind: 'folder' },
      ],
    });
  });

  it('names a shared drive and stops at its root without reading it as a folder', async () => {
    const d = deps(
      [
        { id: 'doc', name: 'Budget', parents: ['f1'], driveId: 'drive1' },
        { id: 'f1', name: 'Finance', parents: ['drive1'], driveId: 'drive1' },
      ],
      { drives: { drive1: 'Team Alpha' } },
    );
    const path = await resolvePath('doc', d);
    expect(path).toEqual({
      kind: 'path',
      partial: false,
      segments: [
        { id: 'drive1', name: 'Team Alpha', kind: 'shared-drive' },
        { id: 'f1', name: 'Finance', kind: 'folder' },
      ],
    });
    expect(d.asked).not.toContain('drive1');
  });

  it('a file at the top of a shared drive is the drive alone', async () => {
    const path = await resolvePath(
      'doc',
      deps([{ id: 'doc', name: 'x', parents: ['d'], driveId: 'd' }], { drives: { d: 'Ops' } }),
    );
    expect(path).toEqual({
      kind: 'path',
      partial: false,
      segments: [{ id: 'd', name: 'Ops', kind: 'shared-drive' }],
    });
  });

  it('a shared drive whose name cannot be read keeps an empty name', async () => {
    const path = await resolvePath(
      'doc',
      deps([{ id: 'doc', name: 'x', parents: ['d'], driveId: 'd' }]),
    );
    expect(path).toEqual({
      kind: 'path',
      partial: false,
      segments: [{ id: 'd', name: '', kind: 'shared-drive' }],
    });
  });

  it('a file without parents is hidden, with its owner', async () => {
    expect(
      await resolvePath(
        'doc',
        deps([{ id: 'doc', name: 'x', owners: [{ displayName: 'Kim Example' }] }]),
      ),
    ).toEqual({
      kind: 'hidden',
      owner: 'Kim Example',
    });
    expect(await resolvePath('doc', deps([{ id: 'doc', name: 'x', owners: [{}] }]))).toEqual({
      kind: 'hidden',
    });
  });

  it('a file the account cannot read is hidden without an owner', async () => {
    expect(await resolvePath('doc', deps([]))).toEqual({ kind: 'hidden' });
  });

  it('an unreadable parent hides the location', async () => {
    const path = await resolvePath(
      'doc',
      deps([{ id: 'doc', name: 'x', parents: ['secret'], owners: [{ displayName: 'Lee' }] }]),
    );
    expect(path).toEqual({ kind: 'hidden', owner: 'Lee' });
  });

  it('an unreadable ancestor higher up gives a partial path', async () => {
    const path = await resolvePath(
      'doc',
      deps([
        { id: 'doc', name: 'x', parents: ['f1'] },
        { id: 'f1', name: 'Shared stuff', parents: ['secret'] },
      ]),
    );
    expect(path).toEqual({
      kind: 'path',
      partial: true,
      segments: [{ id: 'f1', name: 'Shared stuff', kind: 'folder' }],
    });
  });

  it('a folder shared with the account, not in its Drive, ends a partial path', async () => {
    const path = await resolvePath(
      'doc',
      deps([
        { id: 'doc', name: 'x', parents: ['f1'] },
        { id: 'f1', name: 'Shared with me', owners: [{ displayName: 'Other' }] },
      ]),
    );
    expect(path).toEqual({
      kind: 'path',
      partial: true,
      segments: [{ id: 'f1', name: 'Shared with me', kind: 'folder' }],
    });
  });

  it('stops after the maximum depth', async () => {
    const files: DriveFile[] = [{ id: 'doc', name: 'x', parents: ['f0'] }];
    for (let i = 0; i < POLICY.path.maxDepth + 5; i += 1) {
      files.push({ id: `f${i}`, name: `F${i}`, parents: [`f${i + 1}`] });
    }
    const path = await resolvePath('doc', deps(files));
    expect(path.kind === 'path' && path.partial).toBe(true);
    expect(path.kind === 'path' ? path.segments.length : 0).toBe(POLICY.path.maxDepth);
  });

  it('lets a failure other than "not visible" through', async () => {
    const failing: PathDeps = {
      getFile: async () => {
        throw new Error('offline');
      },
      getDriveName: async () => undefined,
      getRootId: async () => 'root',
    };
    await expect(resolvePath('doc', failing)).rejects.toThrow('offline');
  });
});
