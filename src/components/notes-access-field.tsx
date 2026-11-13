import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { t } from '@/lib/i18n';
import { requestYoutubeAccess } from '@/lib/pause-youtube';

interface NotesAccessFieldProps {
  /** Chrome's answer: `null` while it has not given one. */
  granted: boolean | null;
  onDeclined(): void;
  onError(err: unknown): void;
}

/**
 * The notes panel's "Access to YouTube" switch, shown while the access is missing (Settings has
 * the same switch, and is where it is taken back). The request is made straight from the click,
 * before anything is awaited: Chrome shows its prompt only for a user gesture.
 */
export function NotesAccessField({ granted, onDeclined, onError }: NotesAccessFieldProps) {
  return (
    <div className="flex flex-col gap-1 rounded-md border px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor="notes-youtube-access" className="leading-normal font-normal">
          {t('settingsYoutubeAccess')}
        </Label>
        <Switch
          id="notes-youtube-access"
          checked={granted === true}
          disabled={granted !== false}
          title={t('notesAccessTitle')}
          onCheckedChange={(on) => {
            if (on) {
              requestYoutubeAccess().then((ok) => {
                if (!ok) {
                  onDeclined();
                }
              }, onError);
            }
          }}
        />
      </div>
      <p className="text-xs text-muted-foreground">{t('notesAccessHint')}</p>
    </div>
  );
}
