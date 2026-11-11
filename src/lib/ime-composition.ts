/** The parts of a React keyboard event the check reads. */
interface ComposingKeyEvent {
  nativeEvent: { isComposing: boolean };
  keyCode: number;
}

/**
 * Enter pressed to confirm an IME composition (Japanese, Korean, Chinese, …) reaches the input as
 * a keydown too and must not commit the rename. `isComposing` is the standard signal; keyCode 229
 * is the legacy one some IMEs still send with `isComposing` false.
 */
export function isComposingEnter(event: ComposingKeyEvent): boolean {
  return event.nativeEvent.isComposing || event.keyCode === 229;
}

/** The parts of a keyboard event `isSubmitShortcut` reads. */
interface SubmitKeyEvent extends ComposingKeyEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
}

/**
 * Ctrl+Enter (Command+Enter on a Mac; either is taken on both) saves a multi-line text, where a
 * plain Enter is a new line. Not while an IME composition is being confirmed.
 */
export function isSubmitShortcut(event: SubmitKeyEvent): boolean {
  return event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !isComposingEnter(event);
}
