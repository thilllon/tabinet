import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { t, uiLocale } from '@/lib/i18n';
import { followSystemTheme } from '@/lib/theme';
import { applyStoredUiLanguage, followUiLanguageChanges } from '@/lib/ui-language';
import { NotesPanel } from '@/pages/notes-panel';

import '@/styles/index.css';

// The stylesheet's `.dark` palette follows the OS; nothing here stores a theme.
followSystemTheme();

/**
 * React entry of the YouTube notes side panel (notes-panel.html, the manifest's
 * `side_panel.default_path`), started like the app page's (src/pages/index.tsx): the chosen
 * language first, then the first render.
 */
async function start(): Promise<void> {
  await applyStoredUiLanguage();
  followUiLanguageChanges(() => location.reload());
  document.documentElement.lang = uiLocale();
  document.title = t('cmdOpenNotes');

  const root = document.getElementById('notes-panel');
  if (!root) {
    throw new Error('Root element not found');
  }

  createRoot(root).render(
    <StrictMode>
      <NotesPanel />
    </StrictMode>,
  );
}

void start();
