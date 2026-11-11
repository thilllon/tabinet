import { useEffect, useState } from 'react';

import { notesRepo } from '@/lib/notes-repo';

/**
 * A note's screenshot as a data URL, read through `notesRepo`: `undefined` while it loads (or when
 * the note has none), `null` when it is no longer stored. A picture never changes under its id, so
 * it is read once per id and no storage change is followed.
 */
export function useNoteImage(imageId: string | undefined): string | null | undefined {
  const [image, setImage] = useState<{ id: string; src: string | null } | undefined>(undefined);

  useEffect(() => {
    if (imageId === undefined) {
      return;
    }
    let live = true;
    notesRepo.getImage(imageId).then(
      (src) => {
        if (live) {
          setImage({ id: imageId, src: src ?? null });
        }
      },
      (err: unknown) => {
        console.error('[tabinet:notes] screenshot not read', err);
        if (live) {
          setImage({ id: imageId, src: null });
        }
      },
    );
    return () => {
      live = false;
    };
  }, [imageId]);

  // A result for another id (the row now shows another note) counts as still loading.
  return image !== undefined && image.id === imageId ? image.src : undefined;
}
