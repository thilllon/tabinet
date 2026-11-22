import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

/* What #257 made false: waking on a change now does reach the network while signed in to sync. */
describe('copy about when the extension uses the network', () => {
  it.each([
    ['PRIVACY_POLICY.md', 'none of that touches the network', 'Without cloud sync, none'],
    ['site/src/privacy/es.md', 'nada de eso usa la red', 'Sin la sincronización en la nube, nada'],
    [
      'site/src/privacy/ko.md',
      '어느 것도 네트워크를 쓰지 않습니다',
      '클라우드 동기화를 쓰지 않으면 이',
    ],
    [
      'site/src/privacy/ja.md',
      'いずれもネットワークは使いません',
      'クラウド同期を使わなければ、その',
    ],
  ])('%s says it only of a device without sync', (path, claim, qualifier) => {
    const line = read(path)
      .split('\n')
      .find((text) => text.includes(claim));
    expect(line).toContain(qualifier);
  });

  it.each([
    ['PRIVACY_POLICY.md', 'unless sync is failing'],
    ['site/src/privacy/es.md', 'salvo que la sincronización esté fallando'],
    ['site/src/privacy/ko.md', '동기화에 실패하는 중이면'],
    ['site/src/privacy/ja.md', '同期に失敗している間は'],
  ])('%s does not promise seconds while sync is failing', (path, exception) => {
    expect(read(path)).toContain(exception);
  });

  it('the alarms justification does not claim local bookkeeping only', () => {
    expect(read('scripts/store-listing.ts')).not.toContain(
      'in every case to do local bookkeeping only',
    );
  });

  it('the site does not claim that no timer runs at all', () => {
    expect(read('site/src/i18n/copy-en.ts')).not.toContain('no timer runs at all');
  });

  it('Japanese sync text uses full-width parentheses', () => {
    const messages = JSON.parse(read('public/_locales/ja/messages.json')) as Record<
      string,
      { message: string }
    >;
    for (const [key, { message }] of Object.entries(messages)) {
      if (/^settingsAccount(NextCheck|Help)/.test(key)) {
        expect(message, key).not.toMatch(/[()]/);
      }
    }
  });
});
