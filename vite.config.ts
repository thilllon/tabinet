import path from 'node:path';

import { crx, defineManifest } from '@crxjs/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { configDefaults, defineConfig } from 'vitest/config';

import packageJson from './package.json' with { type: 'json' };
import {
  cloudSyncOauth2,
  cloudSyncPermissions,
  DEFAULT_LOCALE,
  DEFAULT_SHORTCUTS,
  YOUTUBE_ORIGINS,
} from './src/constants.ts';

interface PackageJson {
  name?: string;
  displayName?: string;
  version?: string;
  description?: string;
}

const pkg: PackageJson = packageJson;

const manifest = defineManifest((env) => {
  const isDev = env.mode === 'development';

  return {
    // The user-visible text comes from public/_locales/<lang>/messages.json (English is the
    // default and the fallback); src/tests/i18n.test.ts keeps every language complete.
    default_locale: DEFAULT_LOCALE,
    name: isDev ? '__MSG_extName__ Dev' : '__MSG_extName__',
    description: '__MSG_extDescription__',
    version: pkg.version ?? '0.0.0',
    manifest_version: 3,
    // Floor for the APIs used without a runtime guard:
    // - 123: promise-form `chrome.contextMenus.removeAll()` (awaited in src/service-worker.ts)
    // - 104: the `favicon` permission / `_favicon/` endpoint (dashboard tab rows)
    // `chrome.storage.local.getKeys()` (130) is behind a `typeof` guard, so it does not raise this.
    minimum_chrome_version: '123',
    icons: {
      16: 'img/logo-16.png',
      32: 'img/logo-32.png',
      48: 'img/logo-48.png',
      128: 'img/logo-128.png',
    },
    action: {
      default_icon: 'img/logo-48.png',
      // Hovering the icon is the cheapest way to learn the two gestures; the name alone taught
      // nobody that the right-click menu exists.
      default_title: '__MSG_actionTitle__',
    },
    // Chrome's own "Options" item opens the app's Settings view - one page, one place for
    // everything (a fragment is allowed here; verified in Chrome for Testing 151).
    options_page: 'app.html#settings',
    background: {
      service_worker: 'service-worker.ts',
      type: 'module',
    },
    // `alarms` is touched at module-evaluation time (`chrome.alarms.onAlarm.addListener` in
    // src/service-worker.ts), so it must ship with that listener - see AGENTS.md. `scripting` is
    // only called inside a handler ("Pause all YouTube videos", src/lib/pause-youtube.ts) and is
    // useless without the optional YouTube host permission below. `identity` (cloud sync sign-in)
    // is added while CLOUD_SYNC in src/constants.ts names both the server and the Google client, as
    // it does now; nothing touches chrome.identity at load, only Sign in with Google in Settings.
    permissions: [
      'tabs',
      'tabGroups',
      'storage',
      'contextMenus',
      'unlimitedStorage',
      'favicon',
      'alarms',
      'scripting',
      ...cloudSyncPermissions(),
    ],
    // The Google OAuth client `chrome.identity.getAuthToken` signs in with (cloud sync): present
    // while CLOUD_SYNC is configured (it is); a build with an empty apiBase carries no `oauth2` key.
    ...cloudSyncOauth2(),
    // No `host_permissions` and no `content_scripts`: access to YouTube is asked for in Settings,
    // when the person first wants to pause YouTube (chrome.permissions.request needs a click in a
    // page), and can be taken back there. Without it, nothing runs in any web page.
    optional_host_permissions: [...YOUTUBE_ORIGINS],
    // Sorting, assembling and pausing YouTube suggest a key (DEFAULT_SHORTCUTS in src/constants.ts;
    // Chrome takes at most four); the other two ship unbound. Chrome silently drops a suggested_key that conflicts with another extension,
    // so the UI must not promise a key - Settings shows what Chrome actually assigned. Users bind
    // and rebind them at chrome://extensions/shortcuts.
    commands: {
      // Chrome's built-in command for the toolbar icon: a key bound to it fires `action.onClicked`
      // exactly as a click does, so the shortcut sorts (and snapshots) through the very same
      // listeners - there is no second code path to keep in step. Chrome ignores a description
      // here; Settings supplies the name (src/lib/keyboard-shortcuts.ts).
      _execute_action: { suggested_key: { default: DEFAULT_SHORTCUTS._execute_action } },
      'save-session': { description: '__MSG_cmdSaveSession__' },
      'open-dashboard': { description: '__MSG_cmdOpenDashboard__' },
      'assemble-tabs': {
        suggested_key: { default: DEFAULT_SHORTCUTS['assemble-tabs'] },
        description: '__MSG_cmdAssembleTabs__',
      },
      'pause-youtube': {
        suggested_key: { default: DEFAULT_SHORTCUTS['pause-youtube'] },
        description: '__MSG_cmdPauseYoutube__',
      },
    },
  };
});

// https://vitejs.dev/config/
export default defineConfig(() => {
  return {
    // The source tree is the root, so the page is src/app.html yet still builds to dist/app.html
    // (and the extension URL stays app.html); public/ and dist/ stay at the repository root.
    root: path.resolve(import.meta.dirname, 'src'),
    publicDir: path.resolve(import.meta.dirname, 'public'),
    build: {
      outDir: path.resolve(import.meta.dirname, 'dist'),
      emptyOutDir: true,
      // Chrome has supported `<link rel="modulepreload">` natively since long before the
      // `minimum_chrome_version` this extension declares, so the polyfill is dead code - and it
      // ships a bare `fetch()` that a store reviewer auditing our "no network requests without sync" claim
      // would have to rule out by hand. Drop it.
      modulePreload: { polyfill: false },
      rollupOptions: {
        input: {
          // The one page. crxjs only builds the pages the manifest names, and `options_page` carries a
          // `#settings` fragment, so the entry is listed here rather than trusted to be picked up.
          app: path.resolve(import.meta.dirname, 'src/app.html'),
        },
        output: {
          chunkFileNames: 'assets/chunk-[hash].js',
          // The libraries (React, Radix) get a chunk of their own, so neither half passes Vite's
          // 500 kB warning. The page loads both from disk either way; nothing is lazy-loaded.
          codeSplitting: {
            groups: [{ name: 'vendor', test: /node_modules/ }],
          },
        },
      },
    },
    server: {
      port: 5173,
      strictPort: true,
      cors: true,
      // The HMR websocket rides on the dev server above, but the *client* still has to be told
      // which port to dial, and it infers one from `location` when nothing says otherwise. On a
      // `chrome-extension://` page `location.port` is the empty string, so the first attempt went
      // to `ws://localhost:/` and always failed. Vite then retried its "direct" target and HMR did
      // come up, so this is not the difference between working and broken - it is the difference
      // between connecting and connecting after a websocket error on every single page load.
      // `clientPort` rewrites only the client's URL; `ws.port` would instead move the socket onto
      // a second listener, which nothing here wants (crxjs builds its own service-worker client
      // against `server.port`). crxjs sets `server.hmr.host` and no port at all, and Vite 8 folds
      // `server.hmr.*` into `server.ws.*` with an explicit `ws` value winning, so this is the one
      // place the port can be pinned.
      ws: { clientPort: 5173 },
    },
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, './src'),
      },
    },
    plugins: [crx({ manifest }), react(), tailwindcss()],
    legacy: {
      skipWebSocketTokenCheck: true,
    },
    test: {
      // Tests resolve their paths from the repository root, as they did before the root moved.
      root: import.meta.dirname,
      setupFiles: ['src/tests/setup.ts'],
      // Only this tree's suites: Claude Code worktrees under .claude/ carry their own copies, and
      // the sync server (server/) runs its own vitest (`pnpm server:test`).
      exclude: [...configDefaults.exclude, '.claude/**', 'server/**'],
    },
  };
});
