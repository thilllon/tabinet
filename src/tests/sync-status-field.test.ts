import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { SyncStatusField } from '@/components/sync-status-field';
import type { CloudSyncView } from '@/hooks/use-cloud-sync';
import { NO_SYNC_FACTS, type SyncPhase } from '@/lib/cloud-sync-status';
import { t } from '@/lib/i18n';

/** The Sync now button's markup. Server rendering: no DOM needed. */
function syncNowButton(phase: SyncPhase): string {
  const view: CloudSyncView = {
    facts: NO_SYNC_FACTS,
    phase,
    loaded: true,
    sync: async () => true,
  };
  const props = { view, disabled: false, onSync: () => {} };
  const html = renderToStaticMarkup(createElement(SyncStatusField, props));
  const button = html.split('<button').find((part) => part.includes(t('settingsAccountSyncNow')));
  return button ?? '';
}

describe('SyncStatusField', () => {
  it('Sync now keeps the focus through a sync: not disabled, only marked so', () => {
    const button = syncNowButton({ kind: 'syncing' });
    expect(button).toContain('aria-disabled="true"');
    expect(button).not.toMatch(/\sdisabled=/);
    expect(syncNowButton({ kind: 'notSynced' })).not.toContain('aria-disabled="true"');
  });
});
