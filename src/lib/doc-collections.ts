/**
 * The one list of synced doc collections (spec 11.1), in the order the engine applies them. Each
 * entry is a store over its own local storage (`DocStore`); a type not listed here is held when it
 * arrives (8.3) and adopted by a build that lists it. Exactly one store holds screenshots (the
 * YouTube notes store).
 */
import type { AnyDocStore } from '@/lib/cloud-docs';
import { memoStore } from '@/lib/memo-repo';
import { youtubeNoteStore } from '@/lib/notes-repo';

export const DOC_STORES: readonly AnyDocStore[] = [memoStore, youtubeNoteStore];
