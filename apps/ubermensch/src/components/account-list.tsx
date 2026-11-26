import { Button } from '@/components/ui/button';
import { useSignedInAccounts } from '@/hooks/use-signed-in-accounts';
import { signOut } from '@/lib/account-actions';
import { t, uiLocale } from '@/lib/i18n';

/** The accounts signed in for the folder path on this device, each with Sign out. */
export function AccountList() {
  const accounts = useSignedInAccounts();
  if (accounts.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('optionsAccountsNone')}</p>;
  }
  const time = new Intl.DateTimeFormat(uiLocale(), { hour: 'numeric', minute: '2-digit' });
  return (
    <ul className="flex flex-col gap-2">
      {accounts.map((account) => (
        <li key={account.email} className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="truncate font-medium" title={account.email}>
              {account.email}
            </p>
            <p className="text-sm text-muted-foreground">
              {t('optionsAccountUntil', time.format(account.expiresAt))}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            title={t('optionsSignOutTitle', account.email)}
            onClick={() => {
              void signOut(account);
            }}
          >
            {t('optionsSignOut')}
          </Button>
        </li>
      ))}
    </ul>
  );
}
