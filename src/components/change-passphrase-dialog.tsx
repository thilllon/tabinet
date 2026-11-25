import { KeyRound } from 'lucide-react';
import { type FormEvent, useState } from 'react';

import { DialogCloseButton } from '@/components/dialog-close-button';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { POLICY } from '@/constants';
import { newPassphraseProblem } from '@/lib/cloud-auth';
import { t, tp } from '@/lib/i18n';

interface ChangePassphraseDialogProps {
  open: boolean;
  busy: boolean;
  onOpenChange(open: boolean): void;
  /** Called with a passphrase that passed the checks. */
  onSubmit(passphrase: string): void;
}

/** The text of a field of a submitted form, `''` when absent. */
function formText(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

/**
 * Change passphrase (spec 9.2), also the reset of a forgotten one: the new passphrase typed twice,
 * no old one. The fields are uncontrolled and read on submit; an error clears on the next edit
 * with one state change. It does not close while the change runs.
 */
export function ChangePassphraseDialog({
  open,
  busy,
  onOpenChange,
  onSubmit,
}: ChangePassphraseDialogProps) {
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const clearProblem = problem === undefined ? undefined : () => setProblem(undefined);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const passphrase = formText(form, 'passphrase');
    const found = newPassphraseProblem(passphrase, formText(form, 'repeated'));
    if (found === 'empty') {
      setProblem(t('settingsAccountPassphraseEmpty'));
      return;
    }
    if (found === 'short') {
      setProblem(tp('settingsAccountPassphraseTooShort', POLICY.passphrase.minLength));
      return;
    }
    if (found === 'mismatch') {
      setProblem(t('settingsAccountPassphraseMismatch'));
      return;
    }
    onSubmit(passphrase);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}>
      <DialogContent showCloseButton={false}>
        <form onSubmit={submit} noValidate className="space-y-4">
          <DialogHeader>
            <DialogTitle>{t('settingsAccountChangeDialogTitle')}</DialogTitle>
            <DialogDescription>{t('settingsAccountChangeBody')}</DialogDescription>
          </DialogHeader>
          {[
            ['change-passphrase', 'passphrase', t('settingsAccountNewPassphrase')],
            ['change-passphrase-repeat', 'repeated', t('settingsAccountPassphraseRepeat')],
          ].map(([id, name, label]) => (
            <div key={id} className="space-y-1">
              <Label htmlFor={id} className="text-xs font-normal">
                {label}
              </Label>
              <Input
                id={id}
                name={name}
                type="password"
                autoComplete="new-password"
                title={label}
                aria-invalid={problem !== undefined}
                onChange={clearProblem}
              />
            </div>
          ))}
          {problem !== undefined && (
            <p role="alert" className="text-xs text-destructive">
              {problem}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={busy}
              title={t('commonCancel')}
            >
              {t('commonCancel')}
            </Button>
            <Button type="submit" disabled={busy} title={t('settingsAccountChangeTitle')}>
              <KeyRound />
              {t('settingsAccountChangePassphrase')}
            </Button>
          </DialogFooter>
        </form>
        <DialogCloseButton />
      </DialogContent>
    </Dialog>
  );
}
