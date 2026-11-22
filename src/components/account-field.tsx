import { KeyRound, LogOut, RotateCw, Trash2 } from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';

import { DeleteCloudDataDialog } from '@/components/delete-cloud-data-dialog';
import { GoogleLogo } from '@/components/google-logo';
import { SettingsField } from '@/components/settings-field';
import { SyncStatusField } from '@/components/sync-status-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { POLICY } from '@/constants';
import { useCloudAccount } from '@/hooks/use-cloud-account';
import { useCloudSync } from '@/hooks/use-cloud-sync';
import { useErrorToast } from '@/hooks/use-toasts';
import {
  deleteCloudData,
  newPassphraseProblem,
  setUpPassphrase,
  signIn,
  signOut,
  unlockWithPassphrase,
} from '@/lib/cloud-auth';
import { canSignInHere } from '@/lib/cloud-config';
import { markHeldImagesNoticed } from '@/lib/cloud-sync';
import { reportError } from '@/lib/error-message';
import { formatNumber, t, tp } from '@/lib/i18n';
import type { CloudKeySetup } from '@/types';

interface AccountFieldProps {
  onNotice(message: string): void;
  onError(message: string): void;
}

/**
 * Settings > Account: one row for each state of the cloud sync account (`accountState()` in
 * `src/lib/cloud-auth.ts`). Signed out, a Google sign-in button; signed in without a passphrase
 * on the server, a form creating one (typed twice, with the warning that it cannot be
 * recovered); with one on the server but not on this device, a form entering it; with the key
 * here (`showsSyncRow()`: ready, and also before the server answered or while it is out of
 * reach), the address with Sign out and Delete cloud data, then the Sync row (`SyncStatusField`:
 * the live status, the next check, the ? help, Sync now). Rendered only when cloud sync is
 * configured.
 */
export function AccountField({ onNotice, onError }: AccountFieldProps) {
  const cloud = useCloudAccount();
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const syncing = useCloudSync(cloud.syncRow);
  // Beside the Sync row a failed account check takes no line or button of its own, which would
  // move the row: it is a toast, and Sync now is the way to try again. One toast with the sync's
  // own error, as offline both say the same.
  useErrorToast(syncing.facts.lastError ?? (cloud.syncRow ? cloud.error : undefined));

  // Screenshots the server refused over its cap: said once, as a toast, and remembered as said.
  const { heldImages, heldImagesNoticed } = syncing.facts;
  const noticeRef = useRef(onNotice);
  noticeRef.current = onNotice;
  const heldShown = useRef(false);
  useEffect(() => {
    if (heldImages === 0) {
      // Every picture went up: a later refusal is news again.
      heldShown.current = false;
      return;
    }
    if (heldImagesNoticed || heldShown.current) {
      return;
    }
    heldShown.current = true;
    noticeRef.current(
      tp('settingsAccountImagesHeld', heldImages, formatNumber(POLICY.account.screenshots)),
    );
    markHeldImagesNoticed().catch((err: unknown) => reportError('held screenshots notice', err));
  }, [heldImages, heldImagesNoticed]);

  const startSync = () => {
    void syncing.sync().then((synced) => {
      if (synced) {
        onNotice(t('settingsAccountSynced'));
        if (cloud.error !== undefined) {
          // The server answers again, so the account check that failed can be made.
          cloud.refresh();
        }
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

  if (cloud.state === 'unknown' && !cloud.syncRow) {
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

  if (cloud.syncRow) {
    return (
      <>
        <SettingsField
          label={t('settingsAccountGoogle')}
          hint={t('settingsAccountSignedInAs', email)}
        >
          <div className="flex flex-wrap items-center gap-2">
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
          </div>
        </SettingsField>
        <SyncStatusField view={syncing} disabled={busy} onSync={startSync} />
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

/**
 * The new passphrase, typed twice; the problem with it is shown under the fields. The fields are
 * uncontrolled and read from the form on submit, so typing re-renders nothing; an error clears on
 * the first edit after it (a state change only then, never per keystroke).
 */
function CreatePassphraseForm({ busy, onSubmit }: CreatePassphraseFormProps) {
  const [problem, setProblem] = useState<string | undefined>(undefined);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const passphrase = formText(form, 'passphrase');
    const found = newPassphraseProblem(passphrase, formText(form, 'repeated'));
    if (found === 'tooShort') {
      setProblem(tp('settingsAccountPassphraseTooShort', POLICY.passphrase.minLength));
      return;
    }
    if (found === 'mismatch') {
      setProblem(t('settingsAccountPassphraseMismatch'));
      return;
    }
    setProblem(undefined);
    onSubmit(passphrase);
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

/**
 * The existing passphrase on a new device; a wrong one is said under the field. Uncontrolled like
 * the create form: `empty` and `wrong` change only when they flip, so typing re-renders nothing.
 */
function UnlockForm({ setup, busy, setBusy, onUnlocked, onError }: UnlockFormProps) {
  const [empty, setEmpty] = useState(true);
  const [wrong, setWrong] = useState(false);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const passphrase = formText(new FormData(event.currentTarget), 'passphrase');
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
        name="passphrase"
        label={t('settingsAccountPassphrase')}
        autoComplete="current-password"
        invalid={wrong}
        onEdit={(value) => {
          // React skips the render when the value is unchanged, so these cost nothing per keystroke.
          setEmpty(value === '');
          setWrong(false);
        }}
      />
      {wrong && (
        <p role="alert" className="text-xs text-destructive">
          {t('settingsAccountWrongPassphrase')}
        </p>
      )}
      <div className="flex justify-end">
        <Button type="submit" variant="outline" size="sm" disabled={busy || empty}>
          <KeyRound />
          {t('settingsAccountUnlockButton')}
        </Button>
      </div>
    </form>
  );
}

/** A text field of a submitted form, `''` when absent. */
function formText(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

interface PassphraseInputProps {
  id: string;
  name: string;
  label: string;
  autoComplete: 'new-password' | 'current-password';
  invalid: boolean;
  /** Called on each edit with the field's text; leave it out when nothing needs to know. */
  onEdit?: (value: string) => void;
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
        aria-invalid={invalid}
        onChange={onEdit === undefined ? undefined : (event) => onEdit(event.target.value)}
      />
    </div>
  );
}
