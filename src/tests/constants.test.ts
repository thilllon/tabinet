import { describe, expect, it } from 'vitest';

import {
  CLOUD_SYNC,
  cloudSyncConfigured,
  cloudSyncOauth2,
  cloudSyncPermissions,
  DEFAULT_SHORTCUTS,
} from '@/constants';
import { cloudSyncConfig, isCloudSyncEnabled, overrideCloudSyncConfig } from '@/lib/cloud-config';
import { t } from '@/lib/i18n';
import { COMMAND_IDS } from '@/service-worker';

describe('DEFAULT_SHORTCUTS', () => {
  it('only names commands the manifest declares', () => {
    const declared = ['_execute_action', ...Object.values(COMMAND_IDS)];
    for (const id of Object.keys(DEFAULT_SHORTCUTS)) {
      expect(declared).toContain(id);
    }
  });

  it('uses keys Chrome accepts as a suggested_key, each one once', () => {
    const keys = Object.values(DEFAULT_SHORTCUTS);
    for (const key of keys) {
      // Chrome wants Ctrl or Alt in a suggestion, and at most one more modifier before the key.
      expect(key).toMatch(/^(Ctrl|Alt)(\+Shift)?\+[A-Z0-9]$/);
    }
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('the Assemble! label', () => {
  it('is the name followed by its explanation in brackets', () => {
    expect(t('cmdAssembleTabs')).toBe("Assemble! (move every window's tabs into this one)");
    expect(t('cmdAssembleTabs').startsWith(`${t('assembleName')} (`)).toBe(true);
  });
});

describe('cloud sync configuration', () => {
  it('ships switched on: the server and the client, so the identity permission and oauth2 key', () => {
    expect(CLOUD_SYNC.apiBase).toBe('https://tabinet-server.vercel.app');
    expect(cloudSyncConfigured()).toBe(true);
    expect(cloudSyncPermissions()).toEqual(['identity']);
    expect(cloudSyncOauth2()).toEqual({
      oauth2: { client_id: CLOUD_SYNC.googleClientId, scopes: ['openid', 'email'] },
    });
    expect(isCloudSyncEnabled()).toBe(true);
  });

  it('names the Chrome extension OAuth client', () => {
    expect(CLOUD_SYNC.googleClientId).toMatch(/^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/);
  });

  it('needs both values before the feature, its permission and its oauth2 key switch on', () => {
    const server = { apiBase: 'https://sync.test', googleClientId: '' };
    expect(cloudSyncConfigured(server)).toBe(false);
    expect(cloudSyncOauth2(server)).toEqual({});
    expect(cloudSyncConfigured({ apiBase: ' ', googleClientId: 'id' })).toBe(false);
    const both = { apiBase: 'https://sync.test', googleClientId: ' id ' };
    expect(cloudSyncConfigured(both)).toBe(true);
    expect(cloudSyncPermissions(both)).toEqual(['identity']);
    expect(cloudSyncOauth2(both)).toEqual({
      oauth2: { client_id: 'id', scopes: ['openid', 'email'] },
    });
  });

  it('can be switched off or elsewhere for a test and back', () => {
    overrideCloudSyncConfig(() => ({ apiBase: '', googleClientId: 'id' }));
    expect(isCloudSyncEnabled()).toBe(false);
    overrideCloudSyncConfig(() => ({ apiBase: 'https://sync.test', googleClientId: 'id' }));
    expect(isCloudSyncEnabled()).toBe(true);
    expect(cloudSyncConfig().apiBase).toBe('https://sync.test');
    overrideCloudSyncConfig();
    expect(cloudSyncConfig().apiBase).toBe(CLOUD_SYNC.apiBase);
  });

  it('names an https server origin without a path, so routes are /v1 under it', () => {
    const url = new URL(CLOUD_SYNC.apiBase);
    expect(url.protocol).toBe('https:');
    expect(url.pathname).toBe('/');
    expect(CLOUD_SYNC.apiBase.endsWith('/')).toBe(false);
  });
});
