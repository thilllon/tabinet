import path from 'node:path';

import { crx, type CrxPlugin, defineManifest } from '@crxjs/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { configDefaults, defineConfig } from 'vitest/config';

import packageJson from './package.json' with { type: 'json' };
import { DEFAULT_LOCALE, DOCS_ORIGINS } from './src/constants.ts';

const manifest = defineManifest((env) => ({
  // The user-visible text comes from public/_locales/<lang>/messages.json (English is the
  // default and the fallback); src/tests/i18n.test.ts keeps every language complete.
  default_locale: DEFAULT_LOCALE,
  name: env.mode === 'development' ? '__MSG_extName__ Dev' : '__MSG_extName__',
  description: '__MSG_extDescription__',
  version: packageJson.version,
  manifest_version: 3,
  // Floor for the APIs used without a runtime guard: the promise form of
  // `chrome.identity.launchWebAuthFlow` (106), `AbortSignal.timeout` (103), `chrome.storage.session`
  // (102) and `chrome.scripting.registerContentScripts` (96).
  minimum_chrome_version: '106',
  icons: {
    16: 'img/logo-16.png',
    32: 'img/logo-32.png',
    48: 'img/logo-48.png',
    128: 'img/logo-128.png',
  },
  action: {
    default_icon: 'img/logo-48.png',
    default_title: '__MSG_actionTitle__',
  },
  options_page: 'options.html',
  background: {
    service_worker: 'service-worker.ts',
    type: 'module',
  },
  // `identity`: `launchWebAuthFlow`, only from a click on "Show folder". `storage`: tokens and the
  // short cache in `chrome.storage.session`. `scripting`: registering the content script once
  // docs.google.com is granted, and injecting it into Docs tabs already open at that moment.
  // No `tabs`: the one tab query filters by docs.google.com, which the host permission covers.
  permissions: ['identity', 'storage', 'scripting'],
  // Granted from the options page's switch, never at install; removable there too.
  optional_host_permissions: [...DOCS_ORIGINS],
}));

/**
 * crxjs lists every `?iife` script in `web_accessible_resources` for all http(s) pages, which only
 * a script injected by a `<script>` tag would need. Ours is registered with
 * `chrome.scripting.registerContentScripts`, which needs no such entry, and a page could otherwise
 * probe for the file to learn the extension is installed. So the entry is taken out again.
 */
function dropContentScriptWebResources(): CrxPlugin {
  return {
    name: 'ubermensch:drop-content-script-war',
    enforce: 'post',
    renderCrxManifest(manifest) {
      const kept = (manifest.web_accessible_resources ?? []).filter(
        (entry) => !entry.resources.every((file) => file === 'content-script.js'),
      );
      if (kept.length === 0) {
        delete manifest.web_accessible_resources;
      } else {
        manifest.web_accessible_resources = kept;
      }
      return manifest;
    },
  };
}

export default defineConfig({
  // The source tree is the root, so the pages build to dist/options.html; public/ and dist/ sit
  // beside it in this package.
  root: path.resolve(import.meta.dirname, 'src'),
  publicDir: path.resolve(import.meta.dirname, 'public'),
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
    modulePreload: { polyfill: false },
    rollupOptions: {
      output: {
        chunkFileNames: 'assets/chunk-[hash].js',
      },
    },
  },
  server: {
    port: 5174,
    strictPort: true,
    cors: true,
    ws: { clientPort: 5174 },
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
      // The shadcn registry's files import `cn` from an npm package of that name; ours is the
      // same function, so nothing is installed for them.
      cn: path.resolve(import.meta.dirname, './src/lib/utils.ts'),
    },
  },
  plugins: [crx({ manifest }), react(), tailwindcss(), dropContentScriptWebResources()],
  test: {
    root: import.meta.dirname,
    include: ['src/tests/**/*.test.ts'],
    setupFiles: ['src/tests/setup.ts'],
    exclude: [...configDefaults.exclude],
  },
});
