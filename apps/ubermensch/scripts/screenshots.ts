/**
 * Store and website screenshots, headless, from a fixture page (scripts/fixtures/docs-title.html)
 * that imitates an editor title bar. The path is drawn by the extension's own code
 * (scripts/screenshot-entry.ts, bundled here) with fixture names only: no account, no real file.
 *
 *   pnpm --filter ubermensch screenshots            # every language
 *   LOCALES=en pnpm --filter ubermensch screenshots
 *
 * Writes assets/<code>/drive-path-<n>.png at 1280x800 (the store's size) and the small promo tile,
 * assets/promo-small.png at 440x280.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { build } from 'vite';

import { SUPPORTED_LOCALES, type SupportedLocale } from '../src/constants.ts';
import type { DocKind, DocRef, PathAnswer, PathSegment } from '../src/types.ts';
import { launchHeadless } from './browser';

const ROOT = path.resolve(import.meta.dirname, '..');

interface FixtureText {
  title: string;
  menus: string[];
  share: string;
  folders: {
    projects: string;
    planning: string;
    finance: string;
    reports: string;
    archive: string;
    clients: string;
    drafts: string;
    team: string;
  };
  owner: string;
  captions: [string, string, string, string, string];
}

const TEXT: Record<SupportedLocale, FixtureText> = {
  en: {
    title: 'Quarterly plan',
    menus: ['File', 'Edit', 'View', 'Insert', 'Format', 'Tools', 'Help'],
    share: 'Share',
    folders: {
      projects: 'Projects',
      planning: 'Planning',
      finance: 'Finance',
      reports: 'Reports',
      archive: 'Archive',
      clients: 'Clients',
      drafts: 'Drafts',
      team: 'Team Alpha',
    },
    owner: 'Alex Example',
    captions: [
      'The Drive folder, right next to the title',
      'Shared drives too, each folder a link',
      'Long paths are cut in the middle; hover for the whole path',
      'Sign in only when you click Show folder',
      'Shared with you? See who owns it',
    ],
  },
  es: {
    title: 'Plan trimestral',
    menus: ['Archivo', 'Editar', 'Ver', 'Insertar', 'Formato', 'Herramientas', 'Ayuda'],
    share: 'Compartir',
    folders: {
      projects: 'Proyectos',
      planning: 'Planificación',
      finance: 'Finanzas',
      reports: 'Informes',
      archive: 'Archivo',
      clients: 'Clientes',
      drafts: 'Borradores',
      team: 'Equipo Alfa',
    },
    owner: 'Alex Ejemplo',
    captions: [
      'La carpeta de Drive, junto al título',
      'También unidades compartidas, cada carpeta es un enlace',
      'Las rutas largas se acortan en el medio; pasa el cursor para verla entera',
      'Inicia sesión solo al hacer clic en Ver carpeta',
      '¿Te lo compartieron? Mira quién es el propietario',
    ],
  },
  ko: {
    title: '분기 계획',
    menus: ['파일', '수정', '보기', '삽입', '서식', '도구', '도움말'],
    share: '공유',
    folders: {
      projects: '프로젝트',
      planning: '기획',
      finance: '재무',
      reports: '보고서',
      archive: '보관',
      clients: '고객',
      drafts: '초안',
      team: '알파 팀',
    },
    owner: '예시 사용자',
    captions: [
      '제목 바로 옆에 Drive 폴더',
      '공유 드라이브도, 폴더마다 링크',
      '긴 경로는 가운데를 줄이고, 마우스를 올리면 전체 경로',
      '폴더 보기를 클릭할 때만 로그인',
      '공유받은 파일이면 소유자를 표시',
    ],
  },
  ja: {
    title: '四半期計画',
    menus: ['ファイル', '編集', '表示', '挿入', '表示形式', 'ツール', 'ヘルプ'],
    share: '共有',
    folders: {
      projects: 'プロジェクト',
      planning: '企画',
      finance: '経理',
      reports: 'レポート',
      archive: 'アーカイブ',
      clients: '顧客',
      drafts: '下書き',
      team: 'チーム アルファ',
    },
    owner: 'サンプル ユーザー',
    captions: [
      'タイトルのすぐ横に Drive フォルダ',
      '共有ドライブにも対応、フォルダごとにリンク',
      '長いパスは中央を省略、ポインタを合わせると全体を表示',
      'ログインは「フォルダを表示」をクリックしたときだけ',
      '共有されたファイルならオーナーを表示',
    ],
  },
};

const LOGO_COLORS: Record<DocKind, string> = {
  document: '#4285f4',
  spreadsheets: '#0f9d58',
  presentation: '#f4b400',
};

interface Scene {
  kind: DocKind;
  answer: PathAnswer;
}

function folder(id: string, name: string): PathSegment {
  return { id, name, kind: 'folder' };
}

function scenes(text: FixtureText): Scene[] {
  const f = text.folders;
  const myDrive: PathSegment = { id: 'root', name: '', kind: 'my-drive' };
  return [
    {
      kind: 'document',
      answer: {
        state: 'ready',
        path: {
          kind: 'path',
          partial: false,
          segments: [
            myDrive,
            folder('a', f.projects),
            folder('b', '2026'),
            folder('c', f.planning),
          ],
        },
      },
    },
    {
      kind: 'spreadsheets',
      answer: {
        state: 'ready',
        path: {
          kind: 'path',
          partial: false,
          segments: [
            { id: 'd', name: f.team, kind: 'shared-drive' },
            folder('e', f.finance),
            folder('g', f.reports),
          ],
        },
      },
    },
    {
      kind: 'presentation',
      answer: {
        state: 'ready',
        path: {
          kind: 'path',
          partial: false,
          segments: [
            myDrive,
            folder('h', f.archive),
            folder('i', f.clients),
            folder('j', '2024'),
            folder('k', f.projects),
            folder('l', f.drafts),
            folder('m', f.planning),
          ],
        },
      },
    },
    { kind: 'document', answer: { state: 'needs-sign-in' } },
    { kind: 'document', answer: { state: 'ready', path: { kind: 'hidden', owner: text.owner } } },
  ];
}

async function bundleRenderer(): Promise<string> {
  const result = await build({
    configFile: false,
    logLevel: 'warn',
    resolve: { alias: { '@': path.join(ROOT, 'src') } },
    build: {
      write: false,
      minify: false,
      lib: {
        entry: path.join(ROOT, 'scripts/screenshot-entry.ts'),
        formats: ['iife'],
        name: 'UbermenschShot',
        fileName: 'shot',
      },
    },
  });
  const outputs = Array.isArray(result) ? result : [result];
  for (const output of outputs) {
    if ('output' in output) {
      const chunk = output.output.find((item) => item.type === 'chunk');
      if (chunk !== undefined && chunk.type === 'chunk') {
        return chunk.code;
      }
    }
  }
  throw new Error('The renderer did not bundle');
}

function readMessages(code: string): Record<string, string> {
  const parsed: unknown = JSON.parse(
    readFileSync(path.join(ROOT, 'public/_locales', code, 'messages.json'), 'utf8'),
  );
  const out: Record<string, string> = {};
  if (typeof parsed === 'object' && parsed !== null) {
    for (const [key, value] of Object.entries(parsed)) {
      const message: unknown =
        typeof value === 'object' && value !== null ? Reflect.get(value, 'message') : undefined;
      if (typeof message === 'string') {
        out[key] = message;
      }
    }
  }
  return out;
}

/** The store's small promo tile (440x280): the mark, the name and what it does, in English. */
async function promoTile(browser: Awaited<ReturnType<typeof launchHeadless>>): Promise<void> {
  const svg = readFileSync(path.join(ROOT, 'public/img/logo.svg'), 'utf8');
  const page = await browser.newPage({ viewport: { width: 440, height: 280 } });
  await page.setContent(
    `<html><body style="margin:0;width:440px;height:280px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;background:linear-gradient(135deg,#5b48c9,#2f2380);font-family:'Google Sans',Roboto,Arial,sans-serif;color:#fff">
      <div style="width:84px;height:84px">${svg.replace('<svg ', '<svg style="width:84px;height:84px" ')}</div>
      <div style="font-size:34px;font-weight:600">Übermensch</div>
      <div style="font-size:15px;opacity:.9">My Drive \u203a Projects \u203a 2026, next to the title</div>
    </body></html>`,
  );
  await page.screenshot({ path: path.join(ROOT, 'assets/promo-small.png') });
  await page.close();
  console.log('assets/promo-small.png');
}

async function main(): Promise<void> {
  const wanted = (process.env.LOCALES ?? SUPPORTED_LOCALES.join(','))
    .split(',')
    .map((code) => code.trim())
    .filter((code): code is SupportedLocale =>
      (SUPPORTED_LOCALES as readonly string[]).includes(code),
    );
  const renderer = await bundleRenderer();
  const fixture = pathToFileURL(path.join(ROOT, 'scripts/fixtures/docs-title.html')).href;
  const browser = await launchHeadless();
  try {
    mkdirSync(path.join(ROOT, 'assets'), { recursive: true });
    await promoTile(browser);
    for (const code of wanted) {
      const text = TEXT[code];
      const messages = { ...readMessages('en'), ...readMessages(code) };
      const outDir = path.join(ROOT, 'assets', code);
      mkdirSync(outDir, { recursive: true });
      const list = scenes(text);
      for (const [index, scene] of list.entries()) {
        const page = await browser.newPage({
          viewport: { width: 960, height: 600 },
          deviceScaleFactor: 4 / 3,
        });
        // tsx compiles with keepNames, which wraps named functions in `__name()`; the page has none.
        await page.addInitScript({ content: 'window.__name = (fn) => fn;' });
        await page.addInitScript((catalog: Record<string, string>) => {
          const getMessage = (key: string, subs?: string | string[]): string => {
            const list = subs === undefined ? [] : typeof subs === 'string' ? [subs] : subs;
            return (catalog[key] ?? '').replace(/\$(\$|[1-9])/g, (_m, token: string) =>
              token === '$' ? '$' : (list[Number(token) - 1] ?? ''),
            );
          };
          Reflect.set(window, 'chrome', { i18n: { getMessage } });
        }, messages);
        await page.goto(fixture);
        await page.addScriptTag({ content: renderer });
        const doc: DocRef = { kind: scene.kind, fileId: 'fixture-file-id-0001' };
        await page.evaluate(
          ({ text: t, scene: s, doc: d, caption, logo, lang }) => {
            document.documentElement.lang = lang;
            const byId = (id: string): HTMLElement => {
              const element = document.getElementById(id);
              if (element === null) {
                throw new Error(id);
              }
              return element;
            };
            byId('docs-title-widget').textContent = t.title;
            byId('menus').replaceChildren(
              ...t.menus.map((menu) =>
                Object.assign(document.createElement('span'), { textContent: menu }),
              ),
            );
            byId('share').textContent = t.share;
            byId('caption').textContent = caption;
            byId('logo-fill').setAttribute('fill', logo);
            const canvas = byId('canvas');
            if (s.kind === 'spreadsheets') {
              const grid = document.createElement('div');
              grid.className = 'grid';
              for (let i = 0; i < 60; i += 1) {
                grid.append(document.createElement('div'));
              }
              canvas.append(grid);
            } else {
              const sheet = document.createElement('div');
              sheet.className = 'page';
              for (let i = 0; i < 14; i += 1) {
                const line = document.createElement('div');
                line.className = 'line';
                line.style.width = `${60 + ((i * 37) % 40)}%`;
                sheet.append(line);
              }
              canvas.append(sheet);
            }
            const anchor = document.querySelector('.docs-titlebar-badges');
            const shot: unknown = Reflect.get(window, 'UbermenschShot');
            const mount =
              typeof shot === 'object' && shot !== null
                ? Reflect.get(shot, 'mountPath')
                : undefined;
            if (anchor === null || typeof mount !== 'function') {
              throw new Error('fixture not ready');
            }
            mount(anchor, s.answer, d);
          },
          {
            text,
            scene,
            doc,
            caption: text.captions[index] ?? '',
            logo: LOGO_COLORS[scene.kind],
            lang: code,
          },
        );
        const file = path.join(outDir, `drive-path-${index + 1}.png`);
        await page.screenshot({ path: file });
        await page.close();
        console.log(path.relative(ROOT, file));
      }
    }
  } finally {
    await browser.close();
  }
}

void main();
