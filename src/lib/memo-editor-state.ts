/**
 * The memo editor's decisions, apart from React (spec 12.1): the serial save chain and what each
 * save expects to find (`MemoEditorSession`), the draft a closing page leaves (`draft()`), what a
 * change made elsewhere does to the box (`remoteAction()`), and the open editors' flush functions,
 * so a language reload waits for their saves (`flushMemoEditors()`).
 */
import { memoRepo, type MemoSaveInput, type MemoSaveOutcome } from '@/lib/memo-repo';
import type { Memo, MemoDraft } from '@/types';

export type MemoSaver = (input: MemoSaveInput) => Promise<{ outcome: MemoSaveOutcome; memo: Memo }>;

export interface MemoSaveDone {
  outcome: MemoSaveOutcome;
  memo: Memo;
  /** The editor now shows another memo (sync's copy of its text, or a new copy). */
  followed: boolean;
}

/**
 * One editor's saves, one after the other. `saved` is the text last confirmed saved (`null`: no
 * memo yet); `unconfirmed` holds every text whose save started and did not come back, so a save
 * whose answer was lost is still expected. A blank new memo is never stored.
 */
export class MemoEditorSession {
  memoId: string;
  saved: string | null;
  private unconfirmed: string[] = [];
  private chain: Promise<unknown> = Promise.resolve();
  private readonly saver: MemoSaver;

  constructor(
    memoId: string,
    saved: string | null,
    saver: MemoSaver = (input) => memoRepo.save(input),
  ) {
    this.memoId = memoId;
    this.saved = saved;
    this.saver = saver;
  }

  /** What a save of `text` passes as its precondition (11.4). */
  expected(): (string | null)[] {
    return [...new Set([this.saved, ...this.unconfirmed])];
  }

  /** Whether `text` needs a save now. */
  needsSave(text: string): boolean {
    if (text === this.saved) {
      return false;
    }
    return !(this.saved === null && text.trim() === '');
  }

  /**
   * Queues a save of whatever `read()` returns when its turn comes (the box at that moment), and
   * resolves with its result, or `undefined` when nothing needed saving. A failed save rejects
   * and leaves its text expected by the next one.
   */
  save(read: () => string): Promise<MemoSaveDone | undefined> {
    const run = this.chain.then(async (): Promise<MemoSaveDone | undefined> => {
      const text = read();
      if (!this.needsSave(text)) {
        return undefined;
      }
      const expected = this.expected();
      this.unconfirmed.push(text);
      const { outcome, memo } = await this.saver({ id: this.memoId, text, expected });
      const followed = memo.id !== this.memoId;
      this.memoId = memo.id;
      this.saved = memo.text;
      this.unconfirmed = [];
      return { outcome, memo, followed };
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Resolves once every queued save has settled. */
  async idle(): Promise<void> {
    await this.chain;
  }

  /** The draft to leave when the page goes away with `text` in the box, or `null` (12.1). */
  draft(text: string, now: number): MemoDraft | null {
    return draftOf(this.memoId, text, this.saved, this.unconfirmed, now);
  }

  /** The memo was saved elsewhere and the box took its text. */
  adopt(text: string | null): void {
    this.saved = text;
    this.unconfirmed = [];
  }
}

/**
 * A draft of `text` when it differs from the last confirmed text: `bases` = that text, then every
 * text whose save started and was not confirmed. A blank box of a memo never saved leaves none.
 * Pure.
 */
export function draftOf(
  memoId: string,
  text: string,
  saved: string | null,
  unconfirmed: readonly string[],
  now: number,
): MemoDraft | null {
  if (text === saved || (saved === null && text.trim() === '')) {
    return null;
  }
  return {
    schemaVersion: 1,
    id: memoId,
    text,
    bases: [...new Set([saved, ...unconfirmed])],
    at: now,
  };
}

export type RemoteAction =
  /** The box is clean: it takes the stored text. */
  | 'take'
  /** The box is clean and the memo is gone: the editor leaves. */
  | 'leave'
  /** The box was edited: it keeps its text, and its next save makes a copy (or writes into sync's). */
  | 'keep'
  /** Nothing to do (the stored text is what the editor saved). */
  | 'none';

/**
 * What a stored change of the memo does to an editor (12.1), with no save in flight: `stored` is
 * the memo's text now (`null`: deleted), `box` what the editor shows, `saved` its last confirmed
 * text. Pure.
 */
export function remoteAction(
  stored: string | null,
  box: string,
  saved: string | null,
): RemoteAction {
  if (stored === saved) {
    return 'none';
  }
  if (box !== saved) {
    return stored === box ? 'take' : 'keep';
  }
  return stored === null ? 'leave' : 'take';
}

// ---------------------------------------------------------------------------
// The open editors (a language reload waits for them)
// ---------------------------------------------------------------------------

const editors = new Set<() => Promise<void>>();

/** Registers an open editor's flush; the returned function unregisters it. */
export function registerMemoEditor(flush: () => Promise<void>): () => void {
  editors.add(flush);
  return () => {
    editors.delete(flush);
  };
}

/** Saves every open editor now; never rejects (a failed save is the editor's own toast). */
export async function flushMemoEditors(): Promise<void> {
  await Promise.all([...editors].map((flush) => flush().catch(() => undefined)));
}

// ---------------------------------------------------------------------------
// Which editor a memo route shows
// ---------------------------------------------------------------------------

/**
 * The memo editor on screen: its own id (the React key and its draft's name), the memo it writes
 * to, and the memo id its address shows (`undefined` for `#memo/new` until the first save).
 */
export interface MemoEditorSlot {
  editorId: string;
  memoId: string;
  routeId: string | undefined;
  isNew: boolean;
}

/**
 * The editor for a memo route (`routeId`, `undefined` for a new memo): the one on screen while the
 * route is still its own (also after its address moved to the memo it now writes to), else a new
 * one, with a fresh memo id for a new memo. Pure but for `make`.
 */
export function memoEditorFor(
  current: MemoEditorSlot | null,
  routeId: string | undefined,
  make: () => string = () => crypto.randomUUID(),
): MemoEditorSlot {
  if (current !== null && current.routeId === routeId) {
    return current;
  }
  return routeId === undefined
    ? { editorId: make(), memoId: make(), routeId: undefined, isNew: true }
    : { editorId: make(), memoId: routeId, routeId, isNew: false };
}

/** The slot after its editor started writing to `memoId` (its first save, or a copy). Pure. */
export function followedSlot(slot: MemoEditorSlot, memoId: string): MemoEditorSlot {
  return { ...slot, memoId, routeId: memoId };
}
