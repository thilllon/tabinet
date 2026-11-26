import type { Locale } from './locales';

/**
 * Every string of the Übermensch pages (/tabinet/ubermensch/), per language. Names follow the
 * extension's own messages (apps/ubermensch/public/_locales) and Google's terms in each language.
 * When the extension's behaviour changes, change all four, and the store Descriptions in
 * apps/ubermensch/scripts/store-listing.ts.
 */
export interface UbermenschCopy {
  meta: {
    homeTitle: string;
    homeDescription: string;
    supportTitle: string;
    privacyTitle: string;
    privacyDescription: string;
  };
  nav: {
    home: string;
    support: string;
    privacy: string;
    languages: string;
    tabinet: string;
    skip: string;
  };
  hero: { eyebrow: string; title: string; lead: string; status: string; imageAlt: string };
  features: { title: string; items: { title: string; text: string }[] };
  steps: { title: string; items: string[] };
  promises: { title: string; items: string[] };
  support: {
    title: string;
    lead: string;
    reportTitle: string;
    reportLead: string;
    reportButton: string;
    faqTitle: string;
    faq: { q: string; a: string }[];
  };
  privacyNotice: string;
}

const en: UbermenschCopy = {
  meta: {
    homeTitle: 'Übermensch: the Drive folder next to every Google Docs title',
    homeDescription:
      'A Chrome extension that shows the Google Drive folder path of the open Docs, Sheets or Slides file next to its title, each folder a link.',
    supportTitle: 'Übermensch support',
    privacyTitle: 'Übermensch privacy policy',
    privacyDescription: 'What Übermensch reads, where it goes and how long it is kept.',
  },
  nav: {
    home: 'Übermensch',
    support: 'Support',
    privacy: 'Privacy',
    languages: 'Languages',
    tabinet: 'Also by us: Tabinet',
    skip: 'Skip to content',
  },
  hero: {
    eyebrow: 'Chrome extension',
    title: 'Know where every file lives',
    lead: 'Übermensch is a home for small tools that save a few clicks every day. The first one shows the Google Drive folder of the open Docs, Sheets or Slides file right next to its title.',
    status: 'Coming soon to the Chrome Web Store.',
    imageAlt: 'A document title bar with "My Drive › Projects › 2026 › Planning" next to the title',
  },
  features: {
    title: 'Drive path',
    items: [
      {
        title: 'Next to the title',
        text: 'My Drive › Projects › 2026, in Docs, Sheets and Slides. Each folder opens in Google Drive.',
      },
      {
        title: 'Shared drives too',
        text: "A file in a shared drive starts with the shared drive's name.",
      },
      {
        title: 'The right account',
        text: 'With several Google accounts, the path is read for the account the document is open in.',
      },
      {
        title: 'When it is not yours',
        text: 'For a file shared with you, it says the location is not visible and who owns it.',
      },
    ],
  },
  steps: {
    title: 'Getting started',
    items: [
      'Add Übermensch to Chrome and click its icon: the settings open.',
      'Turn on "Access to Google Docs" and accept Chrome\'s prompt.',
      'Open a Docs, Sheets or Slides file and click "Show folder" next to its title.',
      'Sign in with Google once. The path appears, and stays for as long as Chrome is open.',
    ],
  },
  promises: {
    title: 'What it never does',
    items: [
      'It never reads the content of a file: only file and folder names.',
      "It has no server of its own: requests go to Google's API with your own sign-in.",
      'It keeps nothing on disk: the sign-in and the names live in memory and are gone when Chrome closes.',
    ],
  },
  support: {
    title: 'Support',
    lead: 'Answers to common questions, and how to report a problem.',
    reportTitle: 'Report a problem',
    reportLead:
      'Open an issue on GitHub. Say which editor (Docs, Sheets or Slides) and what you saw; never paste file names or links you do not want to share.',
    reportButton: 'Open an issue',
    faqTitle: 'Questions',
    faq: [
      {
        q: 'Why does Google say the app is not verified?',
        a: 'Reading Drive metadata needs a scope Google reviews before it lifts the warning. Until then, choose Advanced and continue. Übermensch asks only for "See information about your Google Drive files", never for content.',
      },
      {
        q: 'Why "Location not visible"?',
        a: 'The file is not in a folder your account can open, usually because someone shared the file itself with you. Übermensch then shows its owner instead.',
      },
      {
        q: 'Why do I have to sign in again?',
        a: "The sign-in is kept in memory only, so it ends when Chrome closes or after about an hour, when Google's token expires.",
      },
      {
        q: 'I use two Google accounts.',
        a: 'Each document asks for the account it is open in (the /u/1/ in its address). Sign in once per account.',
      },
      {
        q: 'Nothing appears next to the title.',
        a: 'Check that "Access to Google Docs" is on in the settings. If Google changed its page, Übermensch shows nothing rather than break it; please report it.',
      },
    ],
  },
  privacyNotice: 'The English policy is the authoritative version.',
};

const es: UbermenschCopy = {
  meta: {
    homeTitle: 'Übermensch: la carpeta de Drive junto al título de cada documento',
    homeDescription:
      'Una extensión de Chrome que muestra la ruta de la carpeta de Google Drive del archivo abierto de Documentos, Hojas o Presentaciones junto a su título.',
    supportTitle: 'Ayuda de Übermensch',
    privacyTitle: 'Política de privacidad de Übermensch',
    privacyDescription: 'Qué lee Übermensch, adónde va y cuánto tiempo se guarda.',
  },
  nav: {
    home: 'Übermensch',
    support: 'Ayuda',
    privacy: 'Privacidad',
    languages: 'Idiomas',
    tabinet: 'También nuestro: Tabinet',
    skip: 'Ir al contenido',
  },
  hero: {
    eyebrow: 'Extensión de Chrome',
    title: 'Sabe dónde está cada archivo',
    lead: 'Übermensch reúne pequeñas herramientas que ahorran unos clics cada día. La primera muestra la carpeta de Google Drive del archivo abierto de Documentos, Hojas o Presentaciones junto a su título.',
    status: 'Pronto en Chrome Web Store.',
    imageAlt:
      'La barra de título de un documento con "Mi unidad › Proyectos › 2026 › Planificación" junto al título',
  },
  features: {
    title: 'Ruta de Drive',
    items: [
      {
        title: 'Junto al título',
        text: 'Mi unidad › Proyectos › 2026, en Documentos, Hojas y Presentaciones. Cada carpeta se abre en Google Drive.',
      },
      {
        title: 'También unidades compartidas',
        text: 'Un archivo de una unidad compartida empieza con el nombre de esa unidad.',
      },
      {
        title: 'La cuenta correcta',
        text: 'Con varias cuentas de Google, la ruta se lee con la cuenta en la que está abierto el documento.',
      },
      {
        title: 'Cuando no es tuyo',
        text: 'Si te compartieron el archivo, indica que la ubicación no es visible y quién es el propietario.',
      },
    ],
  },
  steps: {
    title: 'Primeros pasos',
    items: [
      'Añade Übermensch a Chrome y haz clic en su icono: se abre la configuración.',
      'Activa "Acceso a Documentos de Google" y acepta el aviso de Chrome.',
      'Abre un archivo de Documentos, Hojas o Presentaciones y haz clic en "Ver carpeta" junto al título.',
      'Inicia sesión con Google una vez. La ruta aparece y se mantiene mientras Chrome esté abierto.',
    ],
  },
  promises: {
    title: 'Lo que nunca hace',
    items: [
      'Nunca lee el contenido de un archivo: solo nombres de archivos y carpetas.',
      'No tiene servidor propio: las solicitudes van a la API de Google con tu propio inicio de sesión.',
      'No guarda nada en el disco: la sesión y los nombres viven en memoria y desaparecen al cerrar Chrome.',
    ],
  },
  support: {
    title: 'Ayuda',
    lead: 'Respuestas a preguntas frecuentes y cómo informar de un problema.',
    reportTitle: 'Informar de un problema',
    reportLead:
      'Abre un issue en GitHub. Indica el editor (Documentos, Hojas o Presentaciones) y lo que viste; no pegues nombres de archivos ni enlaces que no quieras compartir.',
    reportButton: 'Abrir un issue',
    faqTitle: 'Preguntas',
    faq: [
      {
        q: '¿Por qué Google dice que la aplicación no está verificada?',
        a: 'Leer metadatos de Drive requiere un permiso que Google revisa antes de quitar el aviso. Mientras tanto, elige Configuración avanzada y continúa. Übermensch solo pide "Ver información sobre tus archivos de Google Drive", nunca el contenido.',
      },
      {
        q: '¿Por qué "Ubicación no visible"?',
        a: 'El archivo no está en una carpeta que tu cuenta pueda abrir, normalmente porque alguien te compartió solo el archivo. Übermensch muestra entonces su propietario.',
      },
      {
        q: '¿Por qué tengo que iniciar sesión otra vez?',
        a: 'La sesión se guarda solo en memoria, así que termina al cerrar Chrome o tras una hora, cuando caduca el token de Google.',
      },
      {
        q: 'Uso dos cuentas de Google.',
        a: 'Cada documento usa la cuenta con la que está abierto (el /u/1/ de su dirección). Inicia sesión una vez por cuenta.',
      },
      {
        q: 'No aparece nada junto al título.',
        a: 'Comprueba que "Acceso a Documentos de Google" esté activado. Si Google cambió su página, Übermensch no muestra nada en lugar de romperla; avísanos.',
      },
    ],
  },
  privacyNotice: 'La política está en inglés; la versión en inglés es la que rige.',
};

const ko: UbermenschCopy = {
  meta: {
    homeTitle: 'Übermensch: Google 문서 제목 옆에 Drive 폴더',
    homeDescription:
      '열려 있는 문서, 스프레드시트, 프레젠테이션 파일의 제목 옆에 Google Drive 폴더 경로를 보여 주는 Chrome 확장 프로그램입니다.',
    supportTitle: 'Übermensch 지원',
    privacyTitle: 'Übermensch 개인정보처리방침',
    privacyDescription: 'Übermensch가 무엇을 읽고, 어디로 보내고, 얼마나 보관하는지.',
  },
  nav: {
    home: 'Übermensch',
    support: '지원',
    privacy: '개인정보',
    languages: '언어',
    tabinet: '같은 개발자: Tabinet',
    skip: '본문으로 건너뛰기',
  },
  hero: {
    eyebrow: 'Chrome 확장 프로그램',
    title: '모든 파일이 어디 있는지 한눈에',
    lead: 'Übermensch는 매일 몇 번의 클릭을 줄여 주는 작은 도구 모음입니다. 첫 번째 도구는 열려 있는 문서, 스프레드시트, 프레젠테이션 파일의 제목 바로 옆에 Google Drive 폴더를 보여 줍니다.',
    status: '곧 Chrome 웹 스토어에 공개됩니다.',
    imageAlt: '문서 제목 옆에 "내 드라이브 › 프로젝트 › 2026 › 기획"이 표시된 제목 표시줄',
  },
  features: {
    title: 'Drive 경로',
    items: [
      {
        title: '제목 바로 옆',
        text: '문서, 스프레드시트, 프레젠테이션에서 내 드라이브 › 프로젝트 › 2026. 폴더마다 Google Drive에서 열립니다.',
      },
      {
        title: '공유 드라이브도',
        text: '공유 드라이브의 파일은 공유 드라이브 이름부터 표시됩니다.',
      },
      {
        title: '올바른 계정으로',
        text: 'Google 계정이 여러 개여도 문서를 연 계정으로 경로를 읽습니다.',
      },
      {
        title: '내 파일이 아닐 때',
        text: '공유받은 파일이면 위치를 볼 수 없다는 것과 소유자를 표시합니다.',
      },
    ],
  },
  steps: {
    title: '시작하기',
    items: [
      'Chrome에 Übermensch를 추가하고 아이콘을 클릭하면 설정이 열립니다.',
      '"Google 문서 접근"을 켜고 Chrome의 확인 창에서 허용합니다.',
      '문서, 스프레드시트, 프레젠테이션 파일을 열고 제목 옆의 "폴더 보기"를 클릭합니다.',
      'Google로 한 번 로그인하면 경로가 표시되고, Chrome을 닫을 때까지 유지됩니다.',
    ],
  },
  promises: {
    title: '절대 하지 않는 일',
    items: [
      '파일 내용은 읽지 않습니다. 파일과 폴더 이름만 읽습니다.',
      '자체 서버가 없습니다. 요청은 내 로그인으로 Google API에만 갑니다.',
      '디스크에 아무것도 저장하지 않습니다. 로그인과 이름은 메모리에만 있고 Chrome을 닫으면 사라집니다.',
    ],
  },
  support: {
    title: '지원',
    lead: '자주 묻는 질문과 문제를 알리는 방법입니다.',
    reportTitle: '문제 알리기',
    reportLead:
      'GitHub에 이슈를 열어 주세요. 어떤 편집기(문서, 스프레드시트, 프레젠테이션)에서 무엇을 봤는지 적어 주세요. 공개하고 싶지 않은 파일 이름이나 링크는 붙이지 마세요.',
    reportButton: '이슈 열기',
    faqTitle: '질문',
    faq: [
      {
        q: 'Google이 확인되지 않은 앱이라고 합니다.',
        a: 'Drive 메타데이터를 읽는 권한은 Google 심사를 거쳐야 경고가 사라집니다. 그때까지는 고급을 누르고 계속하세요. Übermensch는 "Google Drive 파일에 대한 정보 보기"만 요청하고 내용은 요청하지 않습니다.',
      },
      {
        q: '"위치를 볼 수 없음"이 뜹니다.',
        a: '내 계정으로 열 수 있는 폴더에 파일이 없는 경우로, 보통 누군가 파일만 공유했을 때입니다. 이때는 소유자를 보여 줍니다.',
      },
      {
        q: '왜 다시 로그인해야 하나요?',
        a: '로그인은 메모리에만 보관되어 Chrome을 닫거나 약 한 시간 뒤 Google 토큰이 만료되면 끝납니다.',
      },
      {
        q: 'Google 계정을 두 개 씁니다.',
        a: '문서마다 그 문서를 연 계정(주소의 /u/1/)을 사용합니다. 계정마다 한 번씩 로그인하세요.',
      },
      {
        q: '제목 옆에 아무것도 안 보입니다.',
        a: '설정에서 "Google 문서 접근"이 켜져 있는지 확인하세요. Google이 페이지를 바꾸면 Übermensch는 페이지를 망가뜨리지 않고 아무것도 표시하지 않습니다. 알려 주세요.',
      },
    ],
  },
  privacyNotice: '방침은 영어로 되어 있으며, 영어판이 기준입니다.',
};

const ja: UbermenschCopy = {
  meta: {
    homeTitle: 'Übermensch: Google ドキュメントのタイトルの横に Drive フォルダ',
    homeDescription:
      '開いているドキュメント、スプレッドシート、スライドのファイルのタイトルの横に Google Drive のフォルダパスを表示する Chrome 拡張機能です。',
    supportTitle: 'Übermensch サポート',
    privacyTitle: 'Übermensch プライバシーポリシー',
    privacyDescription: 'Übermensch が何を読み、どこへ送り、どれだけ保存するか。',
  },
  nav: {
    home: 'Übermensch',
    support: 'サポート',
    privacy: 'プライバシー',
    languages: '言語',
    tabinet: '同じ開発者: Tabinet',
    skip: '本文へ移動',
  },
  hero: {
    eyebrow: 'Chrome 拡張機能',
    title: 'どのファイルがどこにあるか、すぐわかる',
    lead: 'Übermensch は、毎日の数クリックを省く小さなツール集です。最初のツールは、開いているドキュメント、スプレッドシート、スライドのファイルのタイトルのすぐ横に Google Drive のフォルダを表示します。',
    status: 'まもなく Chrome ウェブストアで公開します。',
    imageAlt: 'タイトルの横に「マイドライブ › プロジェクト › 2026 › 企画」が表示されたタイトルバー',
  },
  features: {
    title: 'Drive パス',
    items: [
      {
        title: 'タイトルのすぐ横に',
        text: 'ドキュメント、スプレッドシート、スライドで マイドライブ › プロジェクト › 2026。フォルダごとに Google Drive で開きます。',
      },
      {
        title: '共有ドライブにも対応',
        text: '共有ドライブのファイルは、その共有ドライブの名前から表示します。',
      },
      {
        title: '正しいアカウントで',
        text: 'Google アカウントが複数あっても、ドキュメントを開いているアカウントでパスを読みます。',
      },
      {
        title: '自分のファイルでないとき',
        text: '共有されたファイルなら、場所を表示できないことと、オーナーを表示します。',
      },
    ],
  },
  steps: {
    title: 'はじめかた',
    items: [
      'Chrome に Übermensch を追加してアイコンをクリックすると、設定が開きます。',
      '「Google ドキュメントへのアクセス」をオンにし、Chrome の確認で許可します。',
      'ドキュメント、スプレッドシート、スライドのファイルを開き、タイトルの横の「フォルダを表示」をクリックします。',
      'Google で一度ログインするとパスが表示され、Chrome を閉じるまで続きます。',
    ],
  },
  promises: {
    title: 'しないこと',
    items: [
      'ファイルの内容は読みません。読むのはファイル名とフォルダ名だけです。',
      '独自のサーバーはありません。リクエストはあなたのログインで Google の API にだけ送ります。',
      'ディスクには何も保存しません。ログインと名前はメモリにだけあり、Chrome を閉じると消えます。',
    ],
  },
  support: {
    title: 'サポート',
    lead: 'よくある質問と、問題の報告方法です。',
    reportTitle: '問題を報告する',
    reportLead:
      'GitHub で issue を作成してください。どのエディタ（ドキュメント、スプレッドシート、スライド）で何が起きたかを書いてください。公開したくないファイル名やリンクは貼らないでください。',
    reportButton: 'issue を作成',
    faqTitle: '質問',
    faq: [
      {
        q: 'Google が「確認されていないアプリ」と表示します。',
        a: 'Drive のメタデータを読む権限は、Google の審査が終わるまで警告が出ます。それまでは「詳細」を選んで続行してください。Übermensch が求めるのは「Google ドライブのファイルに関する情報の表示」だけで、内容は求めません。',
      },
      {
        q: '「場所を表示できません」と出ます。',
        a: 'あなたのアカウントで開けるフォルダにファイルがない場合で、たいていはファイルだけが共有されたときです。その場合はオーナーを表示します。',
      },
      {
        q: 'なぜまたログインが必要なのですか？',
        a: 'ログインはメモリにだけ保存されるため、Chrome を閉じるか、約 1 時間後に Google のトークンが切れると終わります。',
      },
      {
        q: 'Google アカウントを 2 つ使っています。',
        a: 'ドキュメントごとに、それを開いているアカウント（アドレスの /u/1/）を使います。アカウントごとに一度ログインしてください。',
      },
      {
        q: 'タイトルの横に何も表示されません。',
        a: '設定で「Google ドキュメントへのアクセス」がオンか確認してください。Google がページを変えた場合、Übermensch はページを壊さずに何も表示しません。報告してください。',
      },
    ],
  },
  privacyNotice: 'ポリシーは英語で書かれており、英語版が正式なものです。',
};

const COPY: Record<Locale, UbermenschCopy> = { en, es, ko, ja };

export function ubermenschCopy(locale: Locale): UbermenschCopy {
  return COPY[locale];
}
