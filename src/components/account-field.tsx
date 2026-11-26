import { KeyRound, LogOut, RotateCw, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';

import { ChangePassphraseDialog } from '@/components/change-passphrase-dialog';
import { CloudUsageField } from '@/components/cloud-usage-field';
import { ConfirmAccountField } from '@/components/confirm-account-field';
import { DeleteCloudDataDialog } from '@/components/delete-cloud-data-dialog';
import { GoogleLogo } from '@/components/google-logo';
import { SettingsField } from '@/components/settings-field';
import { SignOutDialog } from '@/components/sign-out-dialog';
import { SyncStatusField } from '@/components/sync-status-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { POLICY } from '@/constants';
import { useCloudAccount } from '@/hooks/use-cloud-account';
import { useCloudSync } from '@/hooks/use-cloud-sync';
import { useSyncNotices } from '@/hooks/use-sync-notices';
import { useErrorToast } from '@/hooks/use-toasts';
import {
  cancelAccountSwitch,
  changePassphrase,
  confirmAccount,
  createPassphrase,
  deleteCloudData,
  newPassphraseProblem,
  signIn,
  signOut,
  unlockWithPassphrase,
} from '@/lib/cloud-auth';
import { canSignInHere } from '@/lib/cloud-config';
import { preferredUsage } from '@/lib/cloud-usage';
import { reportError } from '@/lib/error-message';
import { t, tp } from '@/lib/i18n';

interface AccountFieldProps {
  onNotice(message: string): void;
  onError(message: string): void;
}

/** The text of a field of a submitted form, `''` when absent. */
function formText(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

/**
 * Settings > Account: one row for each state of spec 9.3 (`accountState()`), every key action
 * starting from its click. Buttons wait while an action runs, and a dialog does not close during
 * its action. Passphrase fields are uncontrolled and checked on submit. Rendered only when cloud
 * sync is configured.
 */
export function AccountField({ onNotice, onError }: AccountFieldProps) {
  const cloud = useCloudAccount();
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<'delete' | 'signOut' | 'change' | undefined>(undefined);
  const ready = cloud.state === 'ready';
  const syncing = useCloudSync(ready ? cloud.account?.token : undefined);
  useErrorToast(syncing.facts.lastError ?? cloud.error);
  useSyncNotices(syncing.facts, onNotice);

  const run = (context: string, action: () => Promise<void>) => {
    setBusy(true);
    action()
      .catch((err: unknown) => onError(reportError(context, err)))
      .finally(() => {
        setBusy(false);
        setDialog(undefined);
        cloud.refresh();
      });
  };

  if (cloud.state === 'unconfigured') {
    return null;
  }

  const storeOnly = !canSignInHere();
  const signInButton = (
    <Button
      variant="outline"
      size="sm"
      onClick={() => run('cloud sign-in failed', async () => void (await signIn()))}
      disabled={busy || storeOnly}
      title={t('settingsAccountSignInTitle')}
    >
      <GoogleLogo />
      {t('settingsAccountSignIn')}
    </Button>
  );
  const live = cloud.account !== null && cloud.account.expiresAt > Date.now();
  const keyWillGo =
    cloud.key !== null && (!live || cloud.key.accountId === cloud.account?.accountId);
  const signOutNow = () =>
    run('cloud sign-out failed', async () => {
      await signOut();
      onNotice(t('settingsAccountSignedOut'));
    });
  const signOutButton = (
    <Button
      variant="outline"
      size="sm"
      onClick={() => (keyWillGo ? setDialog('signOut') : signOutNow())}
      disabled={busy}
      title={t('settingsAccountSignOutButtonTitle')}
    >
      <LogOut />
      {t('settingsAccountSignOut')}
    </Button>
  );
  const deleteButton = (
    <Button
      variant="outline"
      size="sm"
      onClick={() => setDialog('delete')}
      disabled={busy}
      title={t('settingsAccountDeleteTooltip')}
    >
      <Trash2 />
      {t('settingsAccountDelete')}
    </Button>
  );
  const tryAgain = (
    <Button
      variant="outline"
      size="sm"
      onClick={cloud.refresh}
      disabled={busy}
      title={t('settingsAccountTryAgainTitle')}
    >
      <RotateCw />
      {t('commonTryAgain')}
    </Button>
  );
  const dialogs = (
    <>
      <DeleteCloudDataDialog
        open={dialog === 'delete'}
        busy={busy}
        onOpenChange={(open) => setDialog(open ? 'delete' : undefined)}
        onConfirm={() =>
          run('cloud data not deleted', async () => {
            if ((await deleteCloudData()).outcome === 'deleted') {
              onNotice(t('settingsAccountDeleted'));
            }
          })
        }
      />
      <SignOutDialog
        open={dialog === 'signOut'}
        busy={busy}
        onOpenChange={(open) => setDialog(open ? 'signOut' : undefined)}
        onConfirm={signOutNow}
      />
      <ChangePassphraseDialog
        open={dialog === 'change'}
        busy={busy}
        onOpenChange={(open) => setDialog(open ? 'change' : undefined)}
        onSubmit={(passphrase) =>
          run('sync passphrase not changed', async () => {
            const result = await changePassphrase(passphrase);
            if (result.outcome === 'changed') {
              onNotice(t('settingsAccountChanged'));
            } else if (result.outcome === 'conflict') {
              onError(t('errorCloudKeyConflict'));
            }
          })
        }
      />
    </>
  );
  const email = cloud.account?.email ?? '';
  const signedInAs = t('settingsAccountSignedInAs', email);

  switch (cloud.state) {
    case 'loading':
      return (
        <SettingsField label={t('settingsAccountGoogle')} hint={t('commonLoading')}>
          {null}
        </SettingsField>
      );
    case 'signedOut':
      return (
        <SettingsField
          label={t('settingsAccountGoogle')}
          hint={
            storeOnly
              ? t('settingsAccountStoreOnlyHint')
              : cloud.owner?.legacy === true
                ? t('settingsAccountUpgradeHint')
                : t('settingsAccountSignedOutHint')
          }
        >
          {signInButton}
        </SettingsField>
      );
    case 'expired':
      return (
        <>
          <SettingsField
            label={t('settingsAccountGoogle')}
            hint={storeOnly ? t('settingsAccountStoreOnlyHint') : t('settingsAccountExpired')}
          >
            <div className="flex flex-wrap items-center gap-2">
              {signInButton}
              {signOutButton}
            </div>
          </SettingsField>
          {dialogs}
        </>
      );
    case 'confirmAccount':
      return (
        <>
          <ConfirmAccountField
            ownerEmail={cloud.owner?.email ?? ''}
            email={email}
            busy={busy}
            onKeep={() => run('cloud sign-in not cancelled', () => cancelAccountSwitch())}
            onAdd={() => run('cloud account not confirmed', () => confirmAccount())}
            onDelete={() => setDialog('delete')}
          />
          {dialogs}
        </>
      );
    case 'unknown':
    case 'keyMismatch':
      return (
        <>
          <SettingsField
            label={t('settingsAccountGoogle')}
            hint={
              cloud.state === 'keyMismatch'
                ? t('settingsAccountKeyMismatch')
                : cloud.error !== undefined
                  ? t('settingsAccountCheckFailed')
                  : t('commonLoading')
            }
          >
            <div className="flex flex-wrap items-center gap-2">
              {tryAgain}
              {signOutButton}
              {deleteButton}
            </div>
          </SettingsField>
          {cloud.state === 'keyMismatch' && <CloudUsageField usage={cloud.usage} />}
          {dialogs}
        </>
      );
    case 'needsCreate':
      return (
        <>
          <SettingsField label={t('settingsAccountGoogle')} hint={signedInAs}>
            <div className="flex flex-wrap items-center gap-2">
              {signOutButton}
              {deleteButton}
            </div>
          </SettingsField>
          <CreatePassphraseForm
            busy={busy}
            onSubmit={(passphrase) =>
              run('sync passphrase not created', async () => {
                const result = await createPassphrase(passphrase);
                if (result.outcome === 'created') {
                  onNotice(t('settingsAccountReady'));
                } else if (result.outcome === 'exists') {
                  onNotice(t('settingsAccountPassphraseExists'));
                }
              })
            }
          />
          {dialogs}
        </>
      );
    case 'needsUnlock':
      return (
        <>
          <SettingsField label={t('settingsAccountGoogle')} hint={signedInAs}>
            <div className="flex flex-wrap items-center gap-2">
              {signOutButton}
              {deleteButton}
            </div>
          </SettingsField>
          <UnlockForm
            busy={busy}
            setBusy={setBusy}
            onUnlocked={() => {
              onNotice(t('settingsAccountReady'));
              cloud.refresh();
            }}
            onError={(err) => onError(reportError('sync passphrase not checked', err))}
          />
          <CloudUsageField usage={cloud.usage} />
          {dialogs}
        </>
      );
    case 'ready':
      return (
        <>
          <SettingsField label={t('settingsAccountGoogle')} hint={signedInAs}>
            <div className="flex flex-wrap items-center gap-2">
              {signOutButton}
              {deleteButton}
            </div>
          </SettingsField>
          <CloudUsageField usage={preferredUsage(syncing.facts.usage, cloud.usage)} />
          <SettingsField
            label={t('settingsAccountChangePassphrase')}
            hint={t('settingsAccountChangeHint')}
          >
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDialog('change')}
              disabled={busy || cloud.server === undefined}
              title={t('settingsAccountChangeTitle')}
            >
              <KeyRound />
              {t('settingsAccountChangePassphrase')}
            </Button>
          </SettingsField>
          <SyncStatusField
            view={syncing}
            disabled={busy}
            onSync={() =>
              void syncing.sync().then((synced) => {
                if (synced) {
                  onNotice(t('settingsAccountSynced'));
                }
              })
            }
          />
          {dialogs}
        </>
      );
  }
}

interface CreatePassphraseFormProps {
  busy: boolean;
  onSubmit(passphrase: string): void;
}

/** The new passphrase, typed twice, checked on submit; an error clears on the next edit. */
function CreatePassphraseForm({ busy, onSubmit }: CreatePassphraseFormProps) {
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const passphrase = formText(form, 'passphrase');
    const found = newPassphraseProblem(passphrase, formText(form, 'repeated'));
    if (found === 'empty') {
      setProblem(t('settingsAccountPassphraseEmpty'));
    } else if (found === 'short') {
      setProblem(tp('settingsAccountPassphraseTooShort', POLICY.passphrase.minLength));
    } else if (found === 'mismatch') {
      setProblem(t('settingsAccountPassphraseMismatch'));
    } else {
      setProblem(undefined);
      onSubmit(passphrase);
    }
  };
  const clearProblem = problem === undefined ? undefined : () => setProblem(undefined);
  return (
    <form className="space-y-3" onSubmit={submit} noValidate>
      <div>
        <p className="text-sm">{t('settingsAccountCreatePassphrase')}</p>
        <p className="text-xs font-medium text-destructive">
          {t('settingsAccountCreatePassphraseHint')}
        </p>
      </div>
      <PassphraseInput
        id="cloud-passphrase"
        name="passphrase"
        label={t('settingsAccountPassphrase')}
        autoComplete="new-password"
        invalid={problem !== undefined}
        onEdit={clearProblem}
      />
      <PassphraseInput
        id="cloud-passphrase-repeat"
        name="repeated"
        label={t('settingsAccountPassphraseRepeat')}
        autoComplete="new-password"
        invalid={problem !== undefined}
        onEdit={clearProblem}
      />
      {problem !== undefined && (
        <p role="alert" className="text-xs text-destructive">
          {problem}
        </p>
      )}
      <div className="flex justify-end">
        <Button
          type="submit"
          variant="outline"
          size="sm"
          disabled={busy}
          title={t('settingsAccountCreateTitle')}
        >
          <KeyRound />
          {t('settingsAccountCreateButton')}
        </Button>
      </div>
    </form>
  );
}

interface UnlockFormProps {
  busy: boolean;
  setBusy(busy: boolean): void;
  onUnlocked(): void;
  onError(err: unknown): void;
}

/** The existing passphrase on this device; no minimum. Empty and wrong are said on submit. */
function UnlockForm({ busy, setBusy, onUnlocked, onError }: UnlockFormProps) {
  const [problem, setProblem] = useState<'empty' | 'wrong' | undefined>(undefined);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const passphrase = formText(new FormData(event.currentTarget), 'passphrase');
    if (passphrase === '') {
      setProblem('empty');
      return;
    }
    setBusy(true);
    unlockWithPassphrase(passphrase)
      .then((result) => {
        if (result.outcome === 'wrongPassphrase') {
          setProblem('wrong');
        } else if (result.outcome === 'unlocked') {
          onUnlocked();
        }
      }, onError)
      .finally(() => setBusy(false));
  };
  return (
    <form className="space-y-3" onSubmit={submit} noValidate>
      <div>
        <p className="text-sm">{t('settingsAccountUnlock')}</p>
        <p className="text-xs text-muted-foreground">{t('settingsAccountUnlockHint')}</p>
        <p className="text-xs text-muted-foreground">{t('settingsAccountForgotHint')}</p>
      </div>
      <PassphraseInput
        id="cloud-passphrase-unlock"
        name="passphrase"
        label={t('settingsAccountPassphrase')}
        autoComplete="current-password"
        invalid={problem !== undefined}
        onEdit={problem === undefined ? undefined : () => setProblem(undefined)}
      />
      {problem !== undefined && (
        <p role="alert" className="text-xs text-destructive">
          {problem === 'empty'
            ? t('settingsAccountPassphraseEmpty')
            : t('settingsAccountWrongPassphrase')}
        </p>
      )}
      <div className="flex justify-end">
        <Button
          type="submit"
          variant="outline"
          size="sm"
          disabled={busy}
          title={t('settingsAccountUnlockTitle')}
        >
          <KeyRound />
          {t('settingsAccountUnlockButton')}
        </Button>
      </div>
    </form>
  );
}

interface PassphraseInputProps {
  id: string;
  name: string;
  label: string;
  autoComplete: 'new-password' | 'current-password';
  invalid: boolean;
  /** Called on an edit only while an error shows: one state change, never per keystroke. */
  onEdit?: () => void;
}

function PassphraseInput({ id, name, label, autoComplete, invalid, onEdit }: PassphraseInputProps) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs font-normal">
        {label}
      </Label>
      <Input
        id={id}
        name={name}
        type="password"
        autoComplete={autoComplete}
        title={label}
        aria-invalid={invalid}
        onChange={onEdit}
      />
    </div>
  );
}
