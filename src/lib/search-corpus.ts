import { errorDetail } from '@/lib/error-message';
import { entriesFromSession, type SearchEntry } from '@/lib/search-engine';
import { sessionKey, sessionRepo } from '@/lib/session-repo';
import type { NotesSummary, SessionId, SessionSummary } from '@/types';

/**
 * How many bytes of session bodies the idle pre-warm may read: it stops after 5 MB and the rest
 * is read lazily on the first query. `SessionSummary.bytes` is the JSON length at the last write, so the
 * budget is measured without touching storage.
 */
export const PREWARM_BYTE_BUDGET = 5 * 1024 * 1024;

/** Deadline handed to `requestIdleCallback` so the pre-warm still runs on a busy page. */
const IDLE_TIMEOUT_MS = 2_000;

/** Derived from the repo's own key builder so the two can never drift apart. */
const SESSION_KEY_PREFIX = sessionKey('');

/**
 * The saved sessions the pre-warm should read, newest first (`listSummaries()` order), until the
 * budget is spent. The session that crosses the budget is still included - one body over is
 * cheaper than leaving the newest session, the most likely search target, unloaded - and nothing
 * after it is. History bodies are never pre-warmed: they are opt-in ("Also search auto-saved") and there
 * are up to `historyMaxSnapshots` of them.
 */
export function selectPrewarmIds(
  summaries: readonly SessionSummary[],
  budgetBytes: number = PREWARM_BYTE_BUDGET,
): SessionId[] {
  const ids: SessionId[] = [];
  let total = 0;
  for (const summary of summaries) {
    if (summary.kind !== 'saved') {
      continue;
    }
    // A body this build cannot migrate has nothing to search and never will until the
    // extension is updated; reading it would only cache an empty list and log a warning.
    if (summary.unreadable !== undefined) {
      continue;
    }
    ids.push(summary.id);
    total += summary.bytes;
    if (total >= budgetBytes) {
      break;
    }
  }
  return ids;
}

/** Ids of the session bodies touched by a `chrome.storage.onChanged` batch (local area only). */
export function changedSessionIds(
  changes: Record<string, chrome.storage.StorageChange>,
  area: string,
): SessionId[] {
  if (area !== 'local') {
    return [];
  }
  const ids: SessionId[] = [];
  for (const key of Object.keys(changes)) {
    if (key.startsWith(SESSION_KEY_PREFIX)) {
      ids.push(key.slice(SESSION_KEY_PREFIX.length));
    }
  }
  return ids;
}

/**
 * Runs `callback` when the page is idle, with a `setTimeout` fallback for runtimes without
 * `requestIdleCallback` (vitest runs in Node, and it is still unimplemented in some browsers).
 * The returned function cancels a callback that has not run yet.
 */
export function scheduleIdle(callback: () => void, timeout: number = IDLE_TIMEOUT_MS): () => void {
  if (typeof requestIdleCallback === 'function') {
    const handle = requestIdleCallback(callback, { timeout });
    return () => {
      cancelIdleCallback(handle);
    };
  }
  const timer = setTimeout(callback, 0);
  return () => {
    clearTimeout(timer);
  };
}

/**
 * The tier-2 body cache behind the dashboard's unified search: one `SearchEntry[]` per
 * session, built once by `entriesFromSession()` so a keystroke only tokenises and matches.
 *
 * Reads go through `sessionRepo.getMany()` (never `chrome.storage` directly) and nothing here
 * writes: every id a call needs is fetched in ONE `chrome.storage.local.get([...keys])`, so the
 * idle pre-warm costs one round trip rather than one per session. A body that cannot be
 * read at all - a record from a newer schema version - is cached as an empty list rather than
 * retried on every query: the session stays listed, it is just not searchable.
 */
export class SearchCorpusCache {
  private readonly entries = new Map<SessionId, SearchEntry[]>();
  private readonly inflight = new Map<SessionId, Promise<void>>();
  /**
   * Per-id generation counter, bumped by `invalidate()` / `retain()` / `clear()`. A load that
   * started before the bump drops its result instead of re-caching a body that has since changed
   * or vanished - the same "whichever started last wins" rule the dashboard hooks use.
   */
  private readonly revisions = new Map<SessionId, number>();
  private mutationCount = 0;

  /**
   * Increments on every real change to the cached entries (a body loaded, dropped or cleared) and
   * on nothing else, so a caller can tell "the corpus is the same as last time" from
   * "something moved" without diffing it.
   */
  get mutations(): number {
    return this.mutationCount;
  }

  isLoaded(id: SessionId): boolean {
    return this.entries.has(id);
  }

  /** Number of sessions currently cached (loaded bodies, including empty ones). */
  get loadedCount(): number {
    return this.entries.size;
  }

  /**
   * Loads every id that is neither cached nor already being loaded; resolves when all are in.
   *
   * The ids this call is responsible for are read together in a single `sessionRepo.getMany()`,
   * so a 40-session pre-warm makes one storage request. Ids another call is already loading are
   * awaited rather than re-read, which keeps the per-id coalescing the invalidation relies on.
   */
  async ensureLoaded(ids: Iterable<SessionId>): Promise<void> {
    const pending: Promise<void>[] = [];
    const mine: SessionId[] = [];
    for (const id of ids) {
      if (this.entries.has(id) || mine.includes(id)) {
        continue;
      }
      const running = this.inflight.get(id);
      if (running !== undefined) {
        pending.push(running);
        continue;
      }
      mine.push(id);
    }
    if (mine.length > 0) {
      const batch = this.loadBatch(mine);
      for (const id of mine) {
        const load = batch.finally(() => {
          this.inflight.delete(id);
        });
        this.inflight.set(id, load);
        pending.push(load);
      }
    }
    await Promise.all(pending);
  }

  /** Cached entries for `ids`, in the order given; ids that are not loaded contribute nothing. */
  entriesFor(ids: Iterable<SessionId>): SearchEntry[] {
    const entries: SearchEntry[] = [];
    for (const id of ids) {
      const cached = this.entries.get(id);
      if (cached !== undefined && cached.length > 0) {
        entries.push(...cached);
      }
    }
    return entries;
  }

  /**
   * Drops one session's entries (its body changed, or it was deleted). Returns true when there
   * was something to drop - a cached list or a load in flight - so the caller can decide whether
   * a reload is worth starting.
   */
  invalidate(id: SessionId): boolean {
    const dropped = this.entries.delete(id);
    if (dropped) {
      this.mutationCount += 1;
    }
    this.bump(id);
    return dropped || this.inflight.has(id);
  }

  /**
   * Keeps only the given ids (the session index). Sessions deleted elsewhere - a pruned snapshot,
   * "Delete all session data" - leave the corpus here. Returns the ids that were dropped.
   */
  retain(ids: Iterable<SessionId>): SessionId[] {
    const keep = new Set(ids);
    const dropped: SessionId[] = [];
    for (const id of new Set([...this.entries.keys(), ...this.inflight.keys()])) {
      if (!keep.has(id)) {
        this.invalidate(id);
        dropped.push(id);
      }
    }
    return dropped;
  }

  /** Forgets everything, including the results of loads still in flight. */
  clear(): void {
    for (const id of new Set([...this.entries.keys(), ...this.inflight.keys()])) {
      this.bump(id);
    }
    if (this.entries.size > 0) {
      this.mutationCount += 1;
      this.entries.clear();
    }
  }

  /**
   * Invalidates a session whenever its `session:<id>` body key changes in `chrome.storage.local`
   * (a rename, an edit, a delete, an import). `onInvalidated` receives the ids that had something
   * to drop. The returned function removes the listener - call it from an effect cleanup,
   * these listeners live in the page only.
   */
  subscribe(onInvalidated?: (ids: SessionId[]) => void): () => void {
    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: chrome.storage.AreaName,
    ) => {
      const ids = changedSessionIds(changes, area).filter((id) => this.invalidate(id));
      if (ids.length > 0) {
        onInvalidated?.(ids);
      }
    };
    chrome.storage.onChanged.addListener(listener);
    return () => {
      chrome.storage.onChanged.removeListener(listener);
    };
  }

  private bump(id: SessionId): void {
    this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1);
  }

  /**
   * One `sessionRepo.getMany()` for the whole batch. Every id is cached either way - a session
   * deleted between the index read and this load, and a body that cannot be migrated, both cache
   * an empty list, which is what stops the next query re-reading them. A failed read of the batch
   * itself (storage unavailable) is the only case that caches nothing, so a later call retries.
   */
  private async loadBatch(ids: SessionId[]): Promise<void> {
    const revisions = new Map(ids.map((id) => [id, this.revisions.get(id) ?? 0]));
    let loaded: Awaited<ReturnType<typeof sessionRepo.getMany>>;
    try {
      loaded = await sessionRepo.getMany(ids);
    } catch (err) {
      console.warn('[tabinet:sessions] search corpus load failed', ids, errorDetail(err));
      return;
    }
    for (const id of ids) {
      const failure = loaded.failed.get(id);
      if (failure !== undefined) {
        console.warn('[tabinet:sessions] search corpus load failed', id, errorDetail(failure));
      }
      // A load that started before an invalidation drops its result rather than re-caching a body
      // that has since changed or vanished.
      if ((this.revisions.get(id) ?? 0) !== revisions.get(id)) {
        continue;
      }
      const session = loaded.bodies.get(id);
      this.entries.set(id, session === undefined ? [] : entriesFromSession(session, session.kind));
      this.mutationCount += 1;
    }
  }
}

/**
 * The videos whose notes the search must (re)read: those not read yet, or read at another
 * `updatedAt` than the index now says. Every note write moves the video's `updatedAt` in the index,
 * so the index alone tells a changed video from an unchanged one.
 */
export function notesToLoad(
  summaries: readonly NotesSummary[],
  loadedAt: ReadonlyMap<string, number>,
): string[] {
  return summaries
    .filter((summary) => loadedAt.get(summary.videoId) !== summary.updatedAt)
    .map((summary) => summary.videoId);
}
