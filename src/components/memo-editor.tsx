import { useEffect, useRef } from 'react';

import { Label } from '@/components/ui/label';
import { POLICY } from '@/constants';
import { t } from '@/lib/i18n';
import { isSubmitShortcut } from '@/lib/ime-composition';
import { shortcutText } from '@/lib/keyboard-shortcuts';
import {
  type MemoEditorSession,
  type MemoSaveDone,
  registerMemoEditor,
  remoteAction,
} from '@/lib/memo-editor-state';
import { memoDraftKey, memoRepo } from '@/lib/memo-repo';

interface MemoEditorProps {
  /** Names this editor's draft (`memoDraft:<editorId>`); the same while it follows a copy. */
  editorId: string;
  session: MemoEditorSession;
  initialText: string;
  /** The memo's stored text now: `null` when it is gone, `undefined` while it is being read. */
  stored: string | null | undefined;
  isMac: boolean;
  onSaved(done: MemoSaveDone): void;
  /** A save failed; `leaving` when the editor was closing, so the text is offered to copy. */
  onSaveFailed(err: unknown, text: string, leaving: boolean): void;
  /** The memo was deleted elsewhere and nothing was typed here: the view leaves. */
  onGone(): void;
}

/**
 * The memo's text box (spec 12.1). Uncontrolled: typing writes no state and renders nothing; a
 * timer in a ref saves `POLICY.memo.autosaveMs` after typing pauses, and a save also runs on blur,
 * on Ctrl or Command+Enter, when the page is hidden and when the editor goes. Saves run one after
 * the other through `MemoEditorSession`. When the page goes away, whatever was not confirmed saved
 * is left as a draft, synchronously, for the worker to adopt.
 */
export function MemoEditor({
  editorId,
  session,
  initialText,
  stored,
  isMac,
  onSaved,
  onSaveFailed,
  onGone,
}: MemoEditorProps) {
  const box = useRef<HTMLTextAreaElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const callbacks = useRef({ onSaved, onSaveFailed, onGone });
  callbacks.current = { onSaved, onSaveFailed, onGone };

  useEffect(() => {
    const read = () => box.current?.value ?? '';
    const flush = (leaving = false): Promise<void> => {
      if (timer.current !== undefined) {
        clearTimeout(timer.current);
        timer.current = undefined;
      }
      // The text as it is now, also when the box is already gone (the editor is closing).
      const text = read();
      return session
        .save(() => box.current?.value ?? text)
        .then(
          (done) => {
            if (done !== undefined) {
              callbacks.current.onSaved(done);
            }
          },
          (err: unknown) => {
            callbacks.current.onSaveFailed(err, text, leaving);
            throw err;
          },
        );
    };
    const quietFlush = () => {
      flush().catch(() => undefined);
    };
    const element = box.current;
    // The memo view exists to type in this box; a new memo starts there.
    if (element !== null && element.value === '') {
      element.focus();
    }
    const onInput = () => {
      if (timer.current !== undefined) {
        clearTimeout(timer.current);
      }
      timer.current = setTimeout(quietFlush, POLICY.memo.autosaveMs);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const shortcut = isSubmitShortcut({
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        keyCode: event.keyCode,
        nativeEvent: { isComposing: event.isComposing },
      });
      if (shortcut) {
        event.preventDefault();
        quietFlush();
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        quietFlush();
      }
    };
    // Synchronous, no await and no lock: the only write that reliably survives the page going.
    const onPageHide = () => {
      const draft = session.draft(read(), Date.now());
      if (draft !== null) {
        void chrome.storage.local.set({ [memoDraftKey(editorId)]: draft });
      }
    };
    // Back from the back/forward cache: the memo may have changed (or the draft been adopted).
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) {
        return;
      }
      void memoRepo.get(session.memoId).then((memo) => {
        if (memo !== null && memo !== 'unreadable' && memo.text === read()) {
          session.adopt(memo.text);
        }
      });
    };
    element?.addEventListener('input', onInput);
    element?.addEventListener('blur', quietFlush);
    element?.addEventListener('keydown', onKeyDown);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    const unregister = registerMemoEditor(() => flush());
    return () => {
      unregister();
      element?.removeEventListener('input', onInput);
      element?.removeEventListener('blur', quietFlush);
      element?.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
      flush(true).catch(() => undefined);
    };
  }, [editorId, session]);

  // A change made elsewhere (another tab, sync): a clean box takes it, an edited one keeps its
  // text and its next save makes a copy. Decided once the saves in flight are done.
  useEffect(() => {
    if (stored === undefined) {
      return;
    }
    let cancelled = false;
    void session.idle().then(() => {
      const element = box.current;
      if (cancelled || element === null) {
        return;
      }
      const action = remoteAction(stored, element.value, session.saved);
      if (action === 'take' && stored !== null) {
        element.value = stored;
        session.adopt(stored);
      } else if (action === 'leave') {
        callbacks.current.onGone();
      }
    });
    return () => {
      cancelled = true;
    };
  }, [stored, session]);

  const id = `memo-text-${editorId}`;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Label htmlFor={id} className="sr-only">
        {t('memoLabel')}
      </Label>
      <textarea
        ref={box}
        id={id}
        defaultValue={initialText}
        placeholder={t('memoPlaceholder')}
        title={t('memoTextTitle', shortcutText('Ctrl+Enter', isMac))}
        spellCheck
        className="min-h-[60vh] w-full flex-1 resize-y rounded-lg border bg-card p-3 font-mono text-sm leading-relaxed outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      />
    </div>
  );
}
