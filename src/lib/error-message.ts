/**
 * What a person reads when something fails, always in the UI language. Errors reach the page from
 * three places: our own code (an English message meant for a developer), Chrome and the browser
 * (English whatever the UI language), and our own code again with a message already made with
 * `t()` (`LocalizedError`). Only the last may be shown as it is; everything else is mapped to a
 * localized sentence here, and the original stays in the console (`errorDetail()`).
 */

import { t, type MessageKey } from '@/lib/i18n';
import { MalformedRecordError, UnknownSchemaVersionError } from '@/lib/session-migrate';

/** An error whose message was made with `t()` and so is already in the UI language. */
export class LocalizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalizedError';
  }
}

/**
 * An error with a developer message for the console and a message key for the person: the
 * English `message` says what went wrong inside, `userKey` what the person reads.
 */
export class ExplainedError extends Error {
  constructor(
    message: string,
    public readonly userKey: MessageKey,
  ) {
    super(message);
    this.name = 'ExplainedError';
  }
}

function rawText(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return typeof err === 'string' ? err : '';
}

function errorName(err: unknown): string {
  if (typeof err !== 'object' || err === null) {
    return '';
  }
  const name: unknown = Reflect.get(err, 'name');
  return typeof name === 'string' ? name : '';
}

/**
 * Chrome's own error messages a person can do something about, by what they contain (Chrome words
 * them in English whatever the UI language). Lower case, matched against the lower-cased message.
 */
const KNOWN_MESSAGES: readonly (readonly [string, MessageKey])[] = [
  // "Tabs cannot be edited right now (user may be dragging a tab)."
  ['cannot be edited', 'errorTabsBusy'],
  // "No tab with id: 12." / "No window with id: 3." / "No group with id: 7."
  ['no tab with id', 'errorTabGone'],
  ['no window with id', 'errorTabGone'],
  ['no group with id', 'errorTabGone'],
  // windows.create / windows.update with a position that is off every screen.
  ['invalid value for bounds', 'errorWindowBounds'],
  // Our own restore failure, which reaches the result list as plain text (see ExplainedError).
  ['windows.create returned no window', 'errorRestoreNoWindow'],
];

/**
 * The localized sentence for an error this code knows how to explain, or `undefined` for one it
 * does not (an unexpected bug, a browser message with nothing a person can act on). Pure, so it
 * can run while rendering. A caller that puts the reason inside a sentence of its own uses this
 * and words the `undefined` case without a reason.
 */
export function knownErrorText(err: unknown): string | undefined {
  if (err instanceof LocalizedError) {
    return err.message.length > 0 ? err.message : undefined;
  }
  if (err instanceof ExplainedError) {
    return t(err.userKey);
  }
  if (err instanceof UnknownSchemaVersionError) {
    return t('errorDataTooNew');
  }
  if (err instanceof MalformedRecordError) {
    return t('errorDataUnreadable');
  }
  // Our own index checks (session-edit, session-list, session-export): a window, tab or group the
  // page still showed is gone from the stored session, which another tab or the history ring
  // changed meanwhile.
  if (err instanceof RangeError) {
    return t('errorSessionChanged');
  }
  if (isQuotaError(err)) {
    return t('storageQuotaNotice');
  }
  // The clipboard and other permission-gated browser APIs.
  if (errorName(err) === 'NotAllowedError') {
    return t('errorNotAllowed');
  }
  const lower = rawText(err).toLowerCase();
  for (const [fragment, key] of KNOWN_MESSAGES) {
    if (lower.includes(fragment)) {
      return t(key);
    }
  }
  return undefined;
}

/**
 * The sentence shown for `err` in an error line or toast: the localized explanation when there is
 * one, otherwise a generic localized sentence pointing at the console. Pure; the caller logs the
 * original with `errorDetail()` where the details matter.
 */
export function errorMessage(err: unknown): string {
  if (err === undefined || err === null) {
    return t('storageUnknownError');
  }
  return knownErrorText(err) ?? t('errorGeneric');
}

/** The original, untranslated message, for the console only. */
export function errorDetail(err: unknown): string {
  if (err instanceof Error) {
    return err.message.length > 0 ? `${err.name}: ${err.message}` : err.name;
  }
  if (err === undefined || err === null) {
    return String(err);
  }
  return typeof err === 'string' ? err : (JSON.stringify(err) ?? String(err));
}

/**
 * `errorMessage()` for a catch block that shows the failure: logs the original under `context`
 * so it is not lost when the person sees the generic sentence, and returns what to show.
 */
export function reportError(context: string, err: unknown): string {
  console.error(`[tabinet] ${context}`, err);
  return errorMessage(err);
}

/**
 * Quota classification. Every session write goes through
 * `sessionRepo` → `chrome.storage.local.set`, which rejects when the area is full. Chrome words
 * that rejection several ways depending on where it comes from:
 *
 *   - `Resource::kQuotaBytes quota exceeded`      (storage.local over the quota)
 *   - `QUOTA_BYTES quota exceeded`                (older wording, and storage.sync)
 *   - `QuotaExceededError` / `DOMException(22)`   (the underlying storage layer)
 *
 * …none of which a user can act on, so all of them are shown as one sentence with a way to the
 * storage meter. Pure and unit-tested; the wiring lives in the save / import / "Save as session"
 * paths.
 */

/** DOMException.QUOTA_EXCEEDED_ERR - the legacy numeric code that still travels with it. */
const QUOTA_EXCEEDED_CODE = 22;

function stringField(value: object, key: string): string {
  const field: unknown = Reflect.get(value, key);
  return typeof field === 'string' ? field : '';
}

function numberField(value: object, key: string): number | undefined {
  const field: unknown = Reflect.get(value, key);
  return typeof field === 'number' ? field : undefined;
}

function mentionsQuota(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes('quota') || lower.includes('storage is full');
}

/**
 * True when `err` is a storage-quota rejection rather than an ordinary failure. Deliberately
 * conservative: only the word "quota" (or the `QuotaExceededError` name / code 22) counts, so a
 * genuine bug is never mislabelled as "delete old snapshots".
 */
export function isQuotaError(err: unknown): boolean {
  if (typeof err === 'string') {
    return mentionsQuota(err);
  }
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const name = stringField(err, 'name');
  if (name === 'QuotaExceededError') {
    return true;
  }
  if (numberField(err, 'code') === QUOTA_EXCEEDED_CODE && mentionsQuota(name)) {
    return true;
  }
  return mentionsQuota(stringField(err, 'message'));
}
