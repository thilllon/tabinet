import { XIcon } from 'lucide-react';

import { DialogClose } from '@/components/ui/dialog';
import { t } from '@/lib/i18n';

/**
 * The × in a dialog's top-right corner. The stock one in `src/components/ui/dialog.tsx` carries a
 * fixed English "Close" for screen readers, and that file stays as the shadcn CLI wrote it, so
 * every `DialogContent` passes `showCloseButton={false}` and renders this instead: the same look
 * and position, with the label in the UI language.
 */
export function DialogCloseButton() {
  return (
    <DialogClose
      aria-label={t('commonClose')}
      title={t('commonClose')}
      className="absolute top-4 right-4 rounded-xs opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
    >
      <XIcon aria-hidden="true" />
    </DialogClose>
  );
}
