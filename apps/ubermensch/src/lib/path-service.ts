import { POLICY } from '@/constants';
import {
  DriveApiError,
  DriveNetworkError,
  type FetchLike,
  getDriveName,
  getFile,
  isDriveFile,
} from '@/lib/drive-api';
import { resolvePath } from '@/lib/drive-path';
import { AuthError, isSignInConfigured, signIn } from '@/lib/google-oauth';
import { cacheKey, readCache, writeCache } from '@/lib/session-cache';
import { accountKey, dropToken, readToken } from '@/lib/token-store';
import type { AccountHint, DocRef, DriveFile, DrivePath, PathAnswer } from '@/types';

/**
 * The worker's side of the feature: answer "where is this file?" for one account, from the cache
 * when it is fresh, else from Drive. Never signs in by itself; `signInAndAnswer` is only called for
 * a click.
 */

export interface ServiceDeps {
  fetch: FetchLike;
  now: () => number;
}

/** Thrown inside a walk when the token was refused, to end it and drop the token. */
class TokenRefused extends Error {}

function isDrivePath(value: unknown): value is DrivePath {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const kind: unknown = Reflect.get(value, 'kind');
  if (kind === 'hidden') {
    return true;
  }
  return kind === 'path' && Array.isArray(Reflect.get(value, 'segments'));
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/** A missing file is cached too, as `{ missing: true }`, so a hidden parent is not asked again. */
type CachedFile = DriveFile | { missing: true };

function isCachedFile(value: unknown): value is CachedFile {
  return (
    isDriveFile(value) ||
    (typeof value === 'object' && value !== null && Reflect.get(value, 'missing') === true)
  );
}

async function walk(
  doc: DocRef,
  account: string,
  token: string,
  deps: ServiceDeps,
): Promise<DrivePath> {
  const guard = async <T>(call: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await call();
    } catch (err) {
      if (err instanceof DriveApiError && err.status === 401) {
        throw new TokenRefused();
      }
      if (err instanceof DriveApiError && (err.status === 403 || err.status === 404)) {
        return undefined;
      }
      throw err;
    }
  };

  return resolvePath(doc.fileId, {
    getFile: async (id) => {
      if (id === doc.fileId) {
        // The file itself is always read afresh once its path expired: a move shows at once,
        // while the folders above it (shared by many files) keep their own, longer lifetime.
        return guard(() => getFile(token, id, deps.fetch));
      }
      const key = cacheKey('folder', account, id);
      const cached = await readCache(key, POLICY.cache.folderTtlMs, deps.now(), isCachedFile);
      if (cached !== undefined) {
        return 'missing' in cached ? undefined : cached;
      }
      const file = await guard(() => getFile(token, id, deps.fetch));
      await writeCache<CachedFile>(key, file ?? { missing: true }, deps.now());
      return file;
    },
    getDriveName: async (driveId) => {
      const key = cacheKey('drive', account, driveId);
      const cached = await readCache(key, POLICY.cache.driveTtlMs, deps.now(), isString);
      if (cached !== undefined) {
        return cached;
      }
      const name = await guard(() => getDriveName(token, driveId, deps.fetch));
      if (name !== undefined) {
        await writeCache(key, name, deps.now());
      }
      return name;
    },
    getRootId: async () => {
      const key = cacheKey('root', account, 'root');
      const cached = await readCache(key, POLICY.cache.driveTtlMs, deps.now(), isString);
      if (cached !== undefined) {
        return cached;
      }
      const root = await guard(() => getFile(token, 'root', deps.fetch));
      if (root !== undefined) {
        await writeCache(key, root.id, deps.now());
      }
      return root?.id;
    },
  });
}

/** Where `doc` lives for the account in `hint`, without ever opening a sign-in window. */
export async function answerPath(
  doc: DocRef,
  hint: AccountHint,
  deps: ServiceDeps,
): Promise<PathAnswer> {
  if (!isSignInConfigured()) {
    return { state: 'not-configured' };
  }
  const account = accountKey(hint);
  const token = await readToken(account, deps.now());
  if (token === undefined) {
    return { state: 'needs-sign-in' };
  }
  const fileKey = cacheKey('file', account, doc.fileId);
  const cached = await readCache(fileKey, POLICY.cache.fileTtlMs, deps.now(), isDrivePath);
  if (cached !== undefined) {
    return { state: 'ready', path: cached };
  }
  try {
    const path = await walk(doc, account, token.accessToken, deps);
    await writeCache(fileKey, path, deps.now());
    return { state: 'ready', path };
  } catch (err) {
    if (err instanceof TokenRefused) {
      await dropToken(token.accessToken);
      return { state: 'needs-sign-in' };
    }
    if (err instanceof DriveNetworkError || err instanceof DriveApiError) {
      return { state: 'error', reason: 'network' };
    }
    return { state: 'error', reason: 'unknown' };
  }
}

/** For a click on "Show folder": sign in for the page's account, then answer. */
export async function signInAndAnswer(
  doc: DocRef,
  hint: AccountHint,
  deps: ServiceDeps,
): Promise<PathAnswer> {
  if (!isSignInConfigured()) {
    return { state: 'not-configured' };
  }
  try {
    const result = await signIn(hint, deps.fetch, deps.now);
    if (result.outcome === 'wrong-account') {
      return { state: 'error', reason: 'wrong-account' };
    }
  } catch (err) {
    if (err instanceof AuthError) {
      return {
        state: 'error',
        reason: err.reason === 'cancelled' || err.reason === 'denied' ? 'cancelled' : 'unknown',
      };
    }
    if (err instanceof DriveNetworkError || err instanceof DriveApiError) {
      return { state: 'error', reason: 'network' };
    }
    return { state: 'error', reason: 'unknown' };
  }
  return answerPath(doc, hint, deps);
}
