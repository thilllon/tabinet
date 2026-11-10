/**
 * The cloud sync configuration as the running code reads it. Production reads `CLOUD_SYNC` from
 * `src/constants.ts` (configured, so the feature is on); tests swap the getter to switch it off or
 * point it at a fake server without touching the constant the manifest is built from.
 */
import {
  CLOUD_SYNC,
  type CloudSyncConfig,
  cloudSyncConfigured,
  STORE_EXTENSION_ID,
} from '@/constants';

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

/**
 * Whether Google sign-in can work in this copy of the extension. The OAuth client is bound to the
 * store item id, so an unpacked build (another id) is refused by Chrome: Settings says so and
 * disables the button rather than letting the click fail.
 */
export function canSignInHere(extensionId: string = chrome.runtime.id): boolean {
  // The store screenshots (scripts/prepare-registration.ts) are shot from an unpacked build of
  // this mode and must show the store build's Settings; Vite drops this line from every other build.
  if (import.meta.env.MODE === 'store-screenshots') {
    return true;
  }
  return extensionId === STORE_EXTENSION_ID;
}
