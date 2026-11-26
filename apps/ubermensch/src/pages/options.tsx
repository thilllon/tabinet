import { AccountList } from '@/components/account-list';
import { ClearCacheButton } from '@/components/clear-cache-button';
import { DocsAccessField } from '@/components/docs-access-field';
import { PRIVACY_URL, SUPPORT_URL } from '@/constants';
import { isSignInConfigured } from '@/lib/google-oauth';
import { t } from '@/lib/i18n';

/** The options page: Docs access, the signed-in accounts and the cache. Every control acts at once. */
export function OptionsPage() {
  const configured = isSignInConfigured();
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-8 px-6 py-10">
      <header className="flex items-center gap-3">
        <img src="/img/logo.svg" alt="" width={36} height={36} />
        <h1 className="text-2xl font-semibold">{t('optionsTitle')}</h1>
      </header>

      <section className="flex flex-col gap-5 rounded-lg border bg-card p-6">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold">{t('optionsDrivePathHeading')}</h2>
          <p className="text-sm text-muted-foreground">{t('optionsDrivePathLead')}</p>
        </div>
        <DocsAccessField />
        {configured ? (
          <div className="flex flex-col gap-3">
            <h3 className="font-medium">{t('optionsAccountsHeading')}</h3>
            <AccountList />
            <ClearCacheButton />
          </div>
        ) : (
          <p role="note" className="rounded-md bg-muted p-3 text-sm">
            {t('optionsNotConfigured')}
          </p>
        )}
      </section>

      <footer className="flex gap-4 text-sm">
        <a
          className="text-primary underline-offset-4 hover:underline"
          href={PRIVACY_URL}
          target="_blank"
          rel="noreferrer"
          title={t('optionsPrivacyLink')}
        >
          {t('optionsPrivacyLink')}
        </a>
        <a
          className="text-primary underline-offset-4 hover:underline"
          href={SUPPORT_URL}
          target="_blank"
          rel="noreferrer"
          title={t('optionsSupportLink')}
        >
          {t('optionsSupportLink')}
        </a>
      </footer>
    </main>
  );
}
