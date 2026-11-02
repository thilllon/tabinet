/**
 * The cloud sync configuration as the running code reads it. Production reads `CLOUD_SYNC` from
 * `src/constants.ts` (configured, so the feature is on); tests swap the getter to switch it off or
 * point it at a fake server without touching the constant the manifest is built from.
 */
import { CLOUD_SYNC, type CloudSyncConfig, cloudSyncConfigured } from '@/constants';

const fromConstants = (): CloudSyncConfig => CLOUD_SYNC;

let source: () => CloudSyncConfig = fromConstants;

/** The configuration in use: the server to talk to and the Google client to sign in with. */
export function cloudSyncConfig(): CloudSyncConfig {
  return source();
}

/** Whether cloud sync is switched on in this build (or in this test). */
export function isCloudSyncEnabled(): boolean {
  return cloudSyncConfigured(source());
}

/** Tests only: read the configuration from `getter`, or from `CLOUD_SYNC` again when omitted. */
export function overrideCloudSyncConfig(getter?: () => CloudSyncConfig): void {
  source = getter ?? fromConstants;
}
