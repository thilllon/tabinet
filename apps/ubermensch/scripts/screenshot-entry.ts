/**
 * The extension's own rendering code, bundled by scripts/screenshots.ts into the fixture page, so
 * the store screenshots show exactly what the content script draws (with a stub `chrome.i18n`).
 */
import { pathView } from '@/lib/path-format';
import { createHost, renderView } from '@/lib/path-mount';
import type { DocRef, PathAnswer } from '@/types';

export function mountPath(anchor: Element, answer: PathAnswer, doc: DocRef): void {
  const { host, root } = createHost(anchor.ownerDocument);
  renderView(root, pathView(answer, doc), () => undefined);
  anchor.append(host);
}
