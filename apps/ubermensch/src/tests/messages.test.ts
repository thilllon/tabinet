import { describe, expect, it } from 'vitest';

import { isOwnContentScript, isPathAnswer, isPathRequest } from '@/lib/messages';

const doc = { kind: 'document', fileId: '1AbCdEfGhIjKlMnOp' };

describe('isPathRequest', () => {
  it('accepts the two requests', () => {
    expect(
      isPathRequest({ type: 'ubermensch:get-path', doc, account: { index: 1, email: 'a@b.c' } }),
    ).toBe(true);
    expect(
      isPathRequest({ type: 'ubermensch:sign-in', doc: { ...doc, accountIndex: 2 }, account: {} }),
    ).toBe(true);
  });

  it('refuses anything else', () => {
    expect(isPathRequest(null)).toBe(false);
    expect(isPathRequest({ type: 'other', doc, account: {} })).toBe(false);
    expect(
      isPathRequest({ type: 'ubermensch:get-path', doc: { ...doc, kind: 'forms' }, account: {} }),
    ).toBe(false);
    expect(
      isPathRequest({ type: 'ubermensch:get-path', doc: { ...doc, fileId: '../x' }, account: {} }),
    ).toBe(false);
    expect(isPathRequest({ type: 'ubermensch:get-path', doc, account: { index: -1 } })).toBe(false);
    expect(isPathRequest({ type: 'ubermensch:get-path', doc, account: { email: 3 } })).toBe(false);
  });
});

describe('isOwnContentScript', () => {
  it('accepts only this extension on docs.google.com', () => {
    expect(
      isOwnContentScript({ id: 'me', url: 'https://docs.google.com/document/d/x/edit' }, 'me'),
    ).toBe(true);
    expect(
      isOwnContentScript({ id: 'other', url: 'https://docs.google.com/document/d/x/edit' }, 'me'),
    ).toBe(false);
    expect(isOwnContentScript({ id: 'me', url: 'https://example.com/' }, 'me')).toBe(false);
    expect(isOwnContentScript({ id: 'me' }, 'me')).toBe(false);
  });
});

describe('isPathAnswer', () => {
  it('checks the shape', () => {
    expect(isPathAnswer({ state: 'needs-sign-in' })).toBe(true);
    expect(isPathAnswer({ state: 'ready', path: { kind: 'hidden' } })).toBe(true);
    expect(isPathAnswer({ state: 'ready' })).toBe(false);
    expect(isPathAnswer(undefined)).toBe(false);
  });
});
