import type { SiteCopy } from './site-copy';

export const es: SiteCopy = {
  meta: {
    homeTitle: 'Tabinet - ordena, agrupa y guarda tus pestañas de Chrome',
    homeDescription:
      'Una extensión de Chrome que ordena y agrupa todas tus pestañas con un clic, se ocupa de las duplicadas y guarda ventanas enteras como sesiones para recuperarlas después. Gratis, sin rastreo y sin que nada salga de tu equipo salvo que actives la sincronización cifrada opcional.',
    supportTitle: 'Ayuda - Tabinet',
    supportDescription:
      'Respuestas a las dudas más comunes sobre Tabinet y cómo avisar de un problema o proponer una mejora.',
    privacyTitle: 'Política de privacidad - Tabinet',
    privacyDescription:
      'Tabinet no hace peticiones de red salvo que inicies sesión en su sincronización opcional, cifrada de extremo a extremo. Qué guarda, dónde y durante cuánto tiempo.',
    ogImageAlt:
      'La página de Tabinet con una sesión guardada de dos ventanas y sus grupos de pestañas',
  },
  nav: {
    home: 'Inicio',
    main: 'Principal',
    features: 'Funciones',
    support: 'Ayuda',
    privacy: 'Privacidad',
    language: 'Idioma',
    skipToContent: 'Saltar al contenido',
    github: 'GitHub',
  },
  cta: {
    addToChrome: 'Agregar a Chrome',
    note: 'Gratis · Sin rastreo · Funciona sin conexión',
    seeFeatures: 'Ver qué hace',
  },
  hero: {
    eyebrow: 'Extensión para Chrome',
    title: 'Un clic y cada pestaña vuelve a su sitio.',
    lead: 'Tabinet ordena y agrupa las pestañas de tu ventana, elimina las duplicadas y guarda ventanas completas como sesiones que puedes recuperar cuando quieras. Todo se queda en tu equipo salvo que actives la sincronización.',
    imageAlt:
      'La página de Tabinet: las sesiones guardadas en la columna izquierda y, a la derecha, una sesión de dos ventanas con sus pestañas fijadas y grupos de pestañas',
    languages:
      'La extensión está disponible en English, 한국어, Español y 日本語, y usa el idioma de Chrome o el que elijas en su Configuración.',
  },
  sort: {
    kicker: 'Ordenar',
    title: 'Haz clic en el icono. No hay más.',
    lead: 'Sin ventanas emergentes ni menús de por medio. Un clic en el icono de la barra de herramientas ordena la ventana en la que estás, y decides una sola vez, en Configuración, cómo hacerlo.',
    before: 'Antes',
    after: 'Después',
    beforeAlt:
      'La barra de pestañas de Chrome antes de ordenar: pestañas de Hacker News, YouTube, GitHub, Google y Amazon sin ningún orden',
    afterAlt:
      'La misma barra tras un clic: las pestañas ordenadas por sitio, con las de GitHub y las de Google juntas en grupos de pestañas',
    points: [
      'Por URL, Por título o Personalizado, que agrupa por sitio en el orden en que las abriste',
      'Agrupa por nombre de host completo, o por dominio para reunir todos los servicios de Google',
      'Los grupos de pestañas existentes se ordenan por nombre y por dentro; las pestañas fijadas no se mueven',
    ],
  },
  rows: [
    {
      shot: 'restore',
      kicker: 'Sesiones',
      title: 'Guarda un proyecto para después y recupéralo tal como lo dejaste',
      body: 'Guarda todas las ventanas desde el menú contextual o con el botón Guardar, o solo la actual con una combinación de teclas que tú asignes. Al restaurar vuelven el orden de las pestañas, las pestañas fijadas, los grupos de pestañas, la pestaña activa y el tamaño de la ventana.',
      points: [
        'Abre una sesión en ventanas nuevas o agrégala a la ventana actual',
        'Las sesiones grandes se cargan en diferido, con progreso y botón Cancelar',
        'Restaurar nunca borra la sesión guardada',
      ],
      alt: 'Tabinet pregunta «¿Restaurar 112 pestañas?» con la opción «Cargar las pestañas en diferido», sobre una sesión guardada de tres ventanas',
    },
    {
      shot: 'history',
      kicker: 'Instantáneas automáticas',
      title: 'Una red de seguridad ante cierres inesperados',
      body: 'Cada 5 minutos, y solo si algo ha cambiado, Tabinet guarda una instantánea de todas tus ventanas abiertas. Cuando Chrome vuelve a arrancar, la última aparece marcada como recuperada para que sigas donde lo dejaste.',
      points: [
        'Se conservan las 20 más recientes; tú eliges el intervalo y cuántas',
        'Conservar pasa una instantánea a tus sesiones guardadas para siempre',
        'Activadas por defecto, se desactivan con un clic y entonces no queda ningún temporizador',
      ],
      alt: 'Una instantánea recuperada abierta en Tabinet, con tres instantáneas automáticas en la columna izquierda',
    },
    {
      shot: 'search',
      kicker: 'Búsqueda',
      title: 'Encuentra esa pestaña, esté donde esté',
      body: 'Un único cuadro de búsqueda recorre tus ventanas abiertas y todas las sesiones guardadas por título, dirección o sitio, con los mejores resultados primero. Si lo pides, también busca en las instantáneas.',
      points: [
        'Pulsa / para buscar desde cualquier parte de la página',
        'Flechas para moverte, Intro para abrir, Esc para borrar',
        'Si una pestaña guardada ya está abierta, te lleva a ella en vez de abrirla otra vez',
      ],
      alt: 'Resultados de buscar "github" en Tabinet, con pestañas de dos sesiones guardadas',
    },
    {
      shot: 'settings',
      kicker: 'Pestañas duplicadas y configuración',
      title: 'Pestañas duplicadas, a tu manera',
      body: 'La opción predeterminada es Conservar una: las copias de la misma página se cierran y se queda la que estás viendo. También puedes elegir Conservar todas, o Agruparlas para reunir las copias en un grupo de pestañas y revisarlas antes.',
      points: [
        'Cada opción se guarda al momento, sin botón Guardar',
        'Las opciones para pestañas fijadas y suspendidas quedan en Avanzado',
        '¿Cerraste una duplicada sin querer? Ctrl+Mayús+T la recupera',
      ],
      alt: 'El cuadro de Configuración de Tabinet: «Ordenar por» en «Por URL», «Pestañas duplicadas» en «Conservar una» e «Instantáneas automáticas» activadas',
    },
  ],
  more: {
    title: 'Y todo lo demás',
    lead: 'Detalles que hacen más llevadero tener muchas pestañas abiertas.',
    cards: [
      {
        icon: 'assemble',
        title: '¡Reunir!',
        body: 'Reúne en la ventana que estás usando las pestañas de todas las demás. Las pestañas se mueven, no se vuelven a abrir, así que se conservan los grupos, el historial y lo que hubieras escrito.',
      },
      {
        icon: 'transfer',
        title: 'Importar y exportar',
        body: 'JSON que se vuelve a importar tal cual, Markdown, texto plano, CSV o marcadores HTML para Chrome. Importa un archivo o pega una lista de enlaces, con vista previa antes de guardar.',
      },
      {
        icon: 'keyboard',
        title: 'Combinaciones de teclas',
        body: 'En una instalación nueva, ordenar usa Alt+Mayús+S, ¡Reunir! Alt+Mayús+A y pausar todos los vídeos de YouTube Alt+Mayús+P (Opción en Mac); puedes asignarlas o cambiarlas en chrome://extensions/shortcuts. Guardar una sesión y abrir Tabinet pueden tener sus propias teclas.',
      },
      {
        icon: 'grouping',
        title: 'Se lleva bien con lo que ya usas',
        body: 'Las pestañas suspendidas por The Marvellous Suspender o una extensión similar se ordenan por su dirección real. Llama a tus grupos de pestañas 1-Trabajo, 2-Lectura para fijar su orden.',
      },
    ],
  },
  promise: {
    title: 'Tus pestañas son solo tuyas',
    lead: 'Sin sincronización, Tabinet no envía nada a ningún sitio y funciona igual sin conexión. Con ella, solo tú puedes leer lo que se envía.',
    points: [
      {
        title: 'Se queda en el equipo',
        body: 'Las sesiones y las instantáneas viven en el almacenamiento local de extensiones de Chrome. Las instantáneas nunca salen de ahí; las sesiones guardadas, solo si activas la sincronización.',
      },
      {
        title: 'Sin cuenta obligatoria',
        body: 'Instala y haz clic. Iniciar sesión con Google solo hace falta para la sincronización opcional, y, antes de salir de tu equipo, tus sesiones se cifran en él con una frase de contraseña que solo tú conoces.',
      },
      {
        title: 'Sin rastreo',
        body: 'Sin analíticas, sin rastreo y sin ninguna petición salvo que inicies sesión en la sincronización. Solo en YouTube, si lo permites, ejecuta algo en una página: pausa los vídeos y, para las notas de YouTube, lee el tiempo y el título del vídeo. No lee nada más de las páginas que visitas.',
      },
    ],
    link: 'Leer la política de privacidad',
  },
  closing: {
    title: 'Ordena tus pestañas con un clic',
    lead: 'Gratis en Chrome Web Store. Funciona en Chrome 123 o posterior y debería funcionar también en Edge y Brave.',
  },
  support: {
    title: 'Ayuda',
    lead: 'Respuestas a las preguntas más habituales y cómo contactarnos cuando algo no va bien.',
    startTitle: 'Primeros pasos',
    startSteps: [
      'Agrega Tabinet desde Chrome Web Store y fija su icono en la barra de herramientas.',
      'Haz clic en el icono para ordenar la ventana en la que estás.',
      'Haz clic con el botón derecho en el icono para ver ¡Reunir!, Guardar todas las ventanas como sesión y Pausar todos los vídeos de YouTube. Opciones abre la página de Tabinet, con tus sesiones y tu configuración.',
    ],
    reportTitle: 'Avisar de un problema',
    reportLead:
      '¿Encontraste un error o te falta alguna función? Abre una incidencia en GitHub; leemos todas. Ayuda mucho incluir:',
    reportItems: [
      'tu versión de Chrome (chrome://version) y la de Tabinet',
      'qué hiciste, qué esperabas y qué pasó en realidad',
      'una captura de pantalla, si el problema se ve',
    ],
    reportButton: 'Abrir una incidencia en GitHub',
    openIssues: 'Ver incidencias abiertas',
    versionTitle: 'Versión actual',
    versionText: 'La última versión publicada es la {version}.',
    releases: 'Notas de la versión',
    requirement: 'Necesita Chrome 123 o posterior.',
    faqTitle: 'Preguntas frecuentes',
    faq: [
      {
        q: '¿Ordena todas las ventanas a la vez?',
        a: 'Ordena la ventana en la que estás, así que haz clic en el icono en cada ventana que quieras ordenar. Para juntar antes todas las ventanas, usa ¡Reunir! en el menú contextual. Las sesiones sí pueden abarcar todas las ventanas.',
      },
      {
        q: '¿Desordena mis pestañas fijadas?',
        a: 'No. Por defecto las pestañas fijadas no se tocan. Si quieres que también se ordenen, actívalo en Avanzado, dentro de Configuración.',
      },
      {
        q: '¿Envía mis datos de navegación a algún sitio?',
        a: 'No, salvo que inicies sesión en la sincronización. Sin ella, Tabinet no hace ninguna petición de red y todo ocurre dentro de tu navegador. Con la sincronización activada, tus sesiones guardadas y tu configuración van cifradas al servidor de sincronización de Tabinet, así que solo tú puedes leerlas; las instantáneas automáticas nunca salen del equipo.',
      },
      {
        q: '¿Dónde se guardan mis sesiones?',
        a: 'En el almacenamiento local de extensiones de Chrome de este equipo. Nunca se comparten con páginas web y solo se suben si activas la sincronización, cifradas de extremo a extremo. Puedes borrar una sesión, o todos los datos de sesiones, cuando quieras, y al desinstalar se elimina todo. Exporta a JSON si quieres tu propia copia de seguridad.',
      },
      {
        q: '¿Qué guardan las instantáneas automáticas? ¿Puedo desactivarlas?',
        a: 'Una instantánea contiene lo mismo que una sesión guardada: direcciones, títulos, pestañas fijadas, grupos de pestañas y disposición de las ventanas. Se toma cada 5 minutos (puedes cambiarlo) si algo ha cambiado, y cada vez que haces clic en el icono para ordenar. Por defecto se conservan las 20 más recientes (tú eliges cuántas), además de las que protejas. Desactívalas en Configuración y no queda ningún temporizador.',
      },
      {
        q: '¿Cómo restauro una sesión?',
        a: 'Haz clic con el botón derecho en el icono y elige Opciones (o usa tu combinación de teclas), selecciona la sesión en la columna izquierda y pulsa Abrir. Las ventanas vuelven con su orden, pestañas fijadas, grupos de pestañas y pestaña activa. Abrir aquí agrega una ventana guardada a la actual.',
      },
      {
        q: '¿Puedo llevar mis sesiones a otro equipo?',
        a: 'Sí. Activa la sincronización en los dos equipos y tus sesiones guardadas te acompañan. También puedes exportar todo como JSON e importarlo en el otro equipo, o exportar como HTML e importarlo en los marcadores de Chrome.',
      },
      {
        q: '¿Cómo funciona la sincronización? ¿Puede el servidor leer mis pestañas?',
        a: 'La sincronización es opcional y está desactivada hasta que haces clic en Iniciar sesión con Google en Configuración, Cuenta. Luego creas una frase de contraseña de sincronización: tus sesiones guardadas y tu configuración se cifran con ella en tu equipo antes de enviarse, y la frase nunca se envía, así que el servidor solo guarda datos que no puede leer. Las instantáneas nunca se sincronizan. Si olvidas la frase, nadie puede recuperar la copia de la nube, pero las sesiones de tus equipos se conservan. Eliminar datos de la nube, en el mismo sitio, borra todo del servidor. El inicio de sesión usa el de Google integrado en Chrome, así que puede no funcionar en otros navegadores Chromium.',
      },
      {
        q: '¿Y si no me gusta cómo queda?',
        a: 'Ordenar solo mueve pestañas, así que no se pierde nada. Una duplicada cerrada vuelve con Ctrl+Mayús+T (Cmd+Mayús+T en Mac).',
      },
      {
        q: '¿Puede pausar todos mis vídeos de YouTube a la vez?',
        a: 'Sí. Haz clic con el botón derecho en el icono y elige Pausar todos los vídeos de YouTube, o pulsa su combinación de teclas (Alt+Mayús+P en una instalación nueva, Opción+Mayús+P en Mac; puedes asignarla o cambiarla en chrome://extensions/shortcuts). Todas las pestañas de YouTube de todas las ventanas se pausan donde estaban; nada se silencia ni se cierra, y repetirlo no reanuda nada. La primera vez se abre Configuración en su sección de YouTube para que permitas el acceso; después vuelve a elegirlo. La pausa solo pulsa pausa; las notas de YouTube, en el panel lateral, solo leen el tiempo y el título del vídeo. Puedes quitar el acceso en Configuración cuando quieras.',
      },
      {
        q: '¿Funciona en otros navegadores Chromium?',
        a: 'Necesita Chrome 123 o posterior y debería funcionar en cualquier navegador Chromium de esa generación con grupos de pestañas, como Microsoft Edge y Brave.',
      },
    ],
  },
  privacyPage: {
    notice:
      'Esta es una traducción. Si hay alguna diferencia, prevalece el texto original en inglés.',
    englishLink: 'Ver el original en inglés',
  },
  footer: {
    tagline: 'Ordena, agrupa y guarda tus pestañas. Nada sale de tu equipo si no sincronizas.',
    languages: 'Idiomas',
  },
};
