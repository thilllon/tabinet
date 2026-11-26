import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { t, uiLocale } from '@/lib/i18n';
import { followSystemTheme } from '@/lib/theme';
import { OptionsPage } from '@/pages/options';

import '@/styles/index.css';

followSystemTheme();
document.documentElement.lang = uiLocale();
document.title = t('optionsTitle');

const root = document.getElementById('app');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <OptionsPage />
    </StrictMode>,
  );
}
