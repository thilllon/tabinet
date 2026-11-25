import { CircleQuestionMark } from 'lucide-react';
import { useId } from 'react';

import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { syncHelp } from '@/lib/cloud-sync-help';
import { t } from '@/lib/i18n';

/**
 * The ? beside Sync in Settings > Account: how long syncing takes and why (`syncHelp()`), opened
 * by a click, Enter or Space. `modal` because it opens over the Settings dialog: outside the
 * dialog's DOM the dialog's scroll lock would stop it scrolling, and Escape or a click outside
 * must close only it.
 */
export function SyncHelp() {
  const label = t('settingsAccountHelpLabel');
  const titleId = useId();
  return (
    <Popover modal>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground"
          aria-label={label}
          title={label}
        >
          <CircleQuestionMark aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={12}
        aria-labelledby={titleId}
        className="max-h-(--radix-popover-content-available-height) w-[30rem] max-w-[calc(100vw-1.5rem)] overflow-y-auto overscroll-contain"
      >
        <SyncHelpBody titleId={titleId} />
      </PopoverContent>
    </Popover>
  );
}

/** Rendered only while the popover is open, so nothing is worded before it is asked for. */
function SyncHelpBody({ titleId }: { titleId: string }) {
  const { intro, sections } = syncHelp();
  return (
    <div className="space-y-3 text-xs leading-relaxed [&:lang(ko)]:break-keep wrap-anywhere">
      <h3 id={titleId} className="text-sm font-semibold">
        {t('settingsAccountHelpLabel')}
      </h3>
      <p className="text-muted-foreground">{intro}</p>
      {sections.map(({ title, points }) => (
        <section key={title}>
          <h4 className="font-semibold">{title}</h4>
          <ul className="mt-1 list-disc space-y-1 pl-4 text-muted-foreground">
            {points.map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
