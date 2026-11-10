import { KeyRound, LogOut, RefreshCw, RotateCw, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';

import { DeleteCloudDataDialog } from '@/components/delete-cloud-data-dialog';
import { GoogleLogo } from '@/components/google-logo';
import { SettingsField } from '@/components/settings-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useCloudAccount } from '@/hooks/use-cloud-account';
import { useCloudSync } from '@/hooks/use-cloud-sync';
import { useErrorToast } from '@/hooks/use-toast';
import {
  deleteCloudData,
  newPassphraseProblem,
  PASSPHRASE_MIN_LENGTH,
  setUpPassphrase,
  signIn,
  signOut,
  unlockWithPassphrase,
} from '@/lib/cloud-auth';
import { canSignInHere } from '@/lib/cloud-config';
import { formatDateTime } from '@/lib/display-format';
import { reportError } from '@/lib/error-message';
import { joinSentences, t, tp } from '@/lib/i18n';
import type { CloudKeySetup } from '@/types';

interface AccountFieldProps {
  onNotice(message: string): void;
  onError(message: string): void;
}

/**
 * Settings > Account: one row for each state of the cloud sync account (`accountState()` in
 * `src/lib/cloud-auth.ts`). Signed out, a Google sign-in button; signed in without a passphrase
 * on the server, a form creating one (typed twice, with the warning that it cannot be
 * recovered); with one on the server but not on this device, a form entering it; ready, the
 * address, when the last sync finished (and why it failed), Sync now, Sign out and Delete cloud
 * data. Rendered only when cloud sync is configured.
 */
export function AccountField({ onNotice, onError }: AccountFieldProps) {
  const cloud = useCloudAccount();
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const syncing = useCloudSync(cloud.state === 'ready');
  useErrorToast(syncing.lastError);

  const startSync = () => {
    void syncing.sync().then((synced) => {
      if (synced) {
        onNotice(t('settingsAccountSynced'));
      }
    });
  };

  /** Runs one account action, keeping the buttons still meanwhile and reporting a failure. */
  const run = (context: string, action: () => Promise<void>) => {
    setBusy(true);
    action()
      .catch((err: unknown) => onError(reportError(context, err)))
      .finally(() => {
        setBusy(false);
        cloud.refresh();
      });
  };

  const startSignIn = () => {
    run('cloud sign-in failed', async () => {
      const result = await signIn();
      if (result.outcome === 'signedIn') {
        cloud.setKeySetup(result.keySetup, result.account.token);
      }
    });
  };

  const startSignOut = () => {
    run('cloud sign-out failed', async () => {
      await signOut();
      onNotice(t('settingsAccountSignedOut'));
    });
  };

  const startDelete = () => {
    run('cloud data not deleted', async () => {
      try {
        await deleteCloudData();
        onNotice(t('settingsAccountDeleted'));
      } finally {
        setConfirmDelete(false);
      }
    });
  };

  const signOutButton = (
    <Button variant="outline" size="sm" onClick={startSignOut} disabled={busy}>
      <LogOut />
      {t('settingsAccountSignOut')}
    </Button>
  );

  if (cloud.state === 'unconfigured') {
    return null;
  }

  if (cloud.state === 'unknown') {
    return (
      <SettingsField label={t('settingsAccountGoogle')} hint={cloud.error ?? t('commonLoading')}>
        {cloud.error !== undefined && (
          <Button variant="outline" size="sm" onClick={cloud.refresh}>
            <RotateCw />
            {t('commonTryAgain')}
          </Button>
        )}
        {cloud.error !== undefined && cloud.account !== null && signOutButton}
      </SettingsField>
    );
  }

  if (cloud.state === 'signedOut') {
    return (
      <SettingsField
        label={t('settingsAccountGoogle')}
        hint={t(canSignInHere() ? 'settingsAccountSignedOutHint' : 'settingsAccountStoreOnlyHint')}
      >
        <Button
          variant="outline"
          size="sm"
          onClick={startSignIn}
          disabled={busy || !canSignInHere()}
        >
          <GoogleLogo />
          {t('settingsAccountSignIn')}
        </Button>
      </SettingsField>
    );
  }

  const email = cloud.account?.email ?? '';

  if (cloud.state === 'ready') {
    return (
      <>
        <SettingsField
          label={t('settingsAccountGoogle')}
          hint={joinSentences(
            t('settingsAccountSignedInAs', email),
            syncing.lastSyncAt === null
              ? t('settingsAccountNotSyncedYet')
              : t('settingsAccountLastSync', formatDateTime(syncing.lastSyncAt)),
          )}
        >
          <Button
            variant="outline"
            size="sm"
            onClick={startSync}
            disabled={busy || syncing.syncing}
          >
            <RefreshCw className={syncing.syncing ? 'animate-spin' : undefined} />
            {t('settingsAccountSyncNow')}
          </Button>
          {signOutButton}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setConfirmDelete(true)}
            disabled={busy}
          >
            <Trash2 />
            {t('settingsAccountDelete')}
          </Button>
        </SettingsField>
        <DeleteCloudDataDialog
          open={confirmDelete}
          busy={busy}
          onOpenChange={setConfirmDelete}
          onConfirm={startDelete}
        />
      </>
    );
  }

  return (
    <>
      <SettingsField
        label={t('settingsAccountGoogle')}
        hint={t('settingsAccountSignedInAs', email)}
      >
        {signOutButton}
      </SettingsField>
      {cloud.state === 'needsPassphrase' ? (
        <CreatePassphraseForm
          busy={busy}
          onSubmit={(passphrase) =>
            run('sync passphrase not created', async () => {
              const result = await setUpPassphrase(passphrase);
              if (result.outcome === 'ready') {
                cloud.setKeySetup(result.setup, cloud.account?.token);
                onNotice(t('settingsAccountReady'));
              } else {
                // Another device was first: its passphrase is the one to enter now.
                cloud.setKeySetup(undefined, undefined);
                onNotice(t('settingsAccountPassphraseExists'));
              }
            })
          }
        />
      ) : (
        cloud.keySetup !== undefined &&
        cloud.keySetup !== null && (
          <UnlockForm
            setup={cloud.keySetup}
            busy={busy}
            onUnlocked={() => {
              onNotice(t('settingsAccountReady'));
              cloud.refresh();
            }}
            onError={(err) => onError(reportError('sync passphrase not checked', err))}
            setBusy={setBusy}
          />
        )
      )}
    </>
  );
}

interface CreatePassphraseFormProps {
  busy: boolean;
  onSubmit(passphrase: string): void;
}

/** The new passphrase, typed twice; the problem with it is shown under the fields. */
function CreatePassphraseForm({ busy, onSubmit }: CreatePassphraseFormProps) {
  const [passphrase, setPassphrase] = useState('');
  const [repeated, setRepeated] = useState('');
  const [problem, setProblem] = useState<string | undefined>(undefined);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const found = newPassphraseProblem(passphrase, repeated);
    if (found === 'tooShort') {
      setProblem(tp('settingsAccountPassphraseTooShort', PASSPHRASE_MIN_LENGTH));
      return;
    }
    if (found === 'mismatch') {
      setProblem(t('settingsAccountPassphraseMismatch'));
      return;
    }
    setProblem(undefined);
    onSubmit(passphrase);
  };

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
        label={t('settingsAccountPassphrase')}
        value={passphrase}
        autoComplete="new-password"
        invalid={problem !== undefined}
        onChange={setPassphrase}
      />
      <PassphraseInput
        id="cloud-passphrase-repeat"
        label={t('settingsAccountPassphraseRepeat')}
        value={repeated}
        autoComplete="new-password"
        invalid={problem !== undefined}
        onChange={setRepeated}
      />
      {problem !== undefined && (
        <p role="alert" className="text-xs text-destructive">
          {problem}
        </p>
      )}
      <div className="flex justify-end">
        <Button type="submit" variant="outline" size="sm" disabled={busy}>
          <KeyRound />
          {t('settingsAccountCreateButton')}
        </Button>
      </div>
    </form>
  );
}

interface UnlockFormProps {
  setup: CloudKeySetup;
  busy: boolean;
  setBusy(busy: boolean): void;
  onUnlocked(): void;
  onError(err: unknown): void;
}

/** The existing passphrase on a new device; a wrong one is said under the field. */
function UnlockForm({ setup, busy, setBusy, onUnlocked, onError }: UnlockFormProps) {
  const [passphrase, setPassphrase] = useState('');
  const [wrong, setWrong] = useState(false);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    unlockWithPassphrase(setup, passphrase)
      .then((ok) => {
        setWrong(!ok);
        if (ok) {
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
      </div>
      <PassphraseInput
        id="cloud-passphrase-unlock"
        label={t('settingsAccountPassphrase')}
        value={passphrase}
        autoComplete="current-password"
        invalid={wrong}
        onChange={(value) => {
          setPassphrase(value);
          setWrong(false);
        }}
      />
      {wrong && (
        <p role="alert" className="text-xs text-destructive">
          {t('settingsAccountWrongPassphrase')}
        </p>
      )}
      <div className="flex justify-end">
        <Button type="submit" variant="outline" size="sm" disabled={busy || passphrase === ''}>
          <KeyRound />
          {t('settingsAccountUnlockButton')}
        </Button>
      </div>
    </form>
  );
}

interface PassphraseInputProps {
  id: string;
  label: string;
  value: string;
  autoComplete: 'new-password' | 'current-password';
  invalid: boolean;
  onChange(value: string): void;
}

function PassphraseInput({
  id,
  label,
  value,
  autoComplete,
  invalid,
  onChange,
}: PassphraseInputProps) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs font-normal">
        {label}
      </Label>
      <Input
        id={id}
        type="password"
        value={value}
        autoComplete={autoComplete}
        aria-invalid={invalid}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}
