import { t } from '@/lib/i18n';
import { notesRepo } from '@/lib/notes-repo';
import {
  canonicalVideoUrl,
  entriesByTime,
  formatTimestamp,
  isImageDataUrl,
  videoUrlAt,
} from '@/lib/youtube-video';
import type { VideoNotes } from '@/types';

/**
 * One video's notes as a Markdown file: the title as the heading, the video's link, then one
 * `### [m:ss](link at that second)` section per note in video order with the note's text as
 * written (it is Markdown already) and its screenshot inline as a data URI image, so the file
 * stands alone. Headings and the picture's alternative text are in the UI language; links and
 * times are not. Ends with one newline.
 */
export function notesToMarkdown(notes: VideoNotes, images: ReadonlyMap<string, string>): string {
  const blocks = [`# ${oneLine(videoTitle(notes))}`, canonicalVideoUrl(notes.videoId)];
  for (const entry of entriesByTime(notes.entries)) {
    const time = formatTimestamp(entry.at);
    blocks.push(`### [${time}](${videoUrlAt(notes.videoId, entry.at)})`);
    // Trailing space only: leading indentation can be Markdown (a code block, a nested list).
    const text = entry.text.replace(/\s+$/, '');
    if (text.trim() !== '') {
      blocks.push(text);
    }
    const image = entry.imageId === undefined ? undefined : images.get(entry.imageId);
    // Only a real image data URL goes in: anything else could break out of the `(...)`.
    if (image !== undefined && isImageDataUrl(image)) {
      blocks.push(`![${t('notesScreenshotAt', time)}](${image})`);
    }
  }
  return `${blocks.join('\n\n')}\n`;
}

/** The title a video's notes are shown under: its own, or a stand-in when YouTube gave none. */
export function videoTitle(notes: Pick<VideoNotes, 'title'>): string {
  return notes.title.trim() === '' ? t('notesUntitledVideo') : notes.title;
}

/** A heading is one line: line breaks become spaces. */
function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

/** The screenshots the notes reference, read through `notesRepo`; a missing one is left out. */
export async function readNoteImages(notes: VideoNotes): Promise<Map<string, string>> {
  const ids = notes.entries.flatMap((entry) =>
    entry.imageId === undefined ? [] : [entry.imageId],
  );
  const images = new Map<string, string>();
  for (const id of ids) {
    const image = await notesRepo.getImage(id);
    if (image !== undefined) {
      images.set(id, image);
    }
  }
  return images;
}
