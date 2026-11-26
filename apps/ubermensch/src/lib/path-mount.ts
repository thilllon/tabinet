import type { PathView } from '@/lib/path-format';
import { SEPARATOR } from '@/lib/path-format';

/**
 * Draws a `PathView` into the one element the content script adds to the title bar. The element
 * holds a shadow root, so neither the page's styles reach in nor ours out, and every text is set
 * with `textContent` (nothing from Drive is ever parsed as HTML).
 */

export const HOST_ATTRIBUTE = 'data-ubermensch';

// Colours and type follow Google's own title bar (Google Sans, the grey of its secondary text and
// the blue of its links) so the path reads as part of it. A typographic choice, not a theme.
const STYLE = `
:host {
  all: initial;
  display: inline-flex;
  align-items: center;
  min-width: 0;
  max-width: 44vw;
  height: 24px;
  margin-left: 8px;
  font: 14px/20px "Google Sans", Roboto, Arial, sans-serif;
  color: #444746;
  vertical-align: middle;
}
.row { display: flex; align-items: center; gap: 2px; min-width: 0; white-space: nowrap; overflow: hidden; }
a, .gap { flex: none; padding: 0 4px; border-radius: 4px; overflow: hidden; text-overflow: ellipsis; }
.sep { flex: none; }
/* Only the innermost folder gives way when the title bar is narrow; the others keep their names. */
.row > :last-child { flex: 0 1 auto; min-width: 2em; }
a { color: inherit; text-decoration: none; }
a:hover, a:focus-visible { background: rgba(68, 71, 70, 0.08); text-decoration: underline; outline: none; }
.sep, .gap, .muted { color: #747775; }
.muted { overflow: hidden; text-overflow: ellipsis; }
button {
  all: unset;
  height: 22px;
  padding: 0 10px;
  border: 1px solid #c4c7c5;
  border-radius: 11px;
  color: #0b57d0;
  font: 500 13px/20px "Google Sans", Roboto, Arial, sans-serif;
  cursor: pointer;
  white-space: nowrap;
}
button:hover, button:focus-visible { background: rgba(11, 87, 208, 0.08); }
`;

export function createHost(doc: Document): { host: HTMLElement; root: ShadowRoot } {
  const host = doc.createElement('span');
  host.setAttribute(HOST_ATTRIBUTE, 'drive-path');
  const root = host.attachShadow({ mode: 'open' });
  return { host, root };
}

export function renderView(
  root: ShadowRoot,
  view: PathView,
  onAction: (action: 'sign-in' | 'retry') => void,
): void {
  const doc = root.ownerDocument;
  const style = doc.createElement('style');
  style.textContent = STYLE;
  const row = doc.createElement('span');
  row.className = 'row';
  row.title = view.title;

  switch (view.kind) {
    case 'path':
      view.items.forEach((item, index) => {
        if (index > 0) {
          const sep = doc.createElement('span');
          sep.className = 'sep';
          sep.textContent = SEPARATOR;
          sep.setAttribute('aria-hidden', 'true');
          row.append(sep);
        }
        if (item.href === undefined) {
          const gap = doc.createElement('span');
          gap.className = 'gap';
          gap.textContent = item.label;
          gap.title = item.title;
          row.append(gap);
        } else {
          const link = doc.createElement('a');
          link.href = item.href;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.textContent = item.label;
          link.title = item.title;
          row.append(link);
        }
      });
      row.setAttribute('role', 'navigation');
      row.setAttribute('aria-label', view.title);
      break;
    case 'button': {
      const button = doc.createElement('button');
      button.type = 'button';
      button.textContent = view.text;
      button.title = view.title;
      const action = view.action;
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        onAction(action);
      });
      row.append(button);
      break;
    }
    case 'text':
    case 'loading': {
      const text = doc.createElement('span');
      text.className = 'muted';
      text.textContent = view.text;
      row.append(text);
      if (view.kind === 'loading') {
        row.setAttribute('aria-busy', 'true');
      }
      break;
    }
  }
  root.replaceChildren(style, row);
}
