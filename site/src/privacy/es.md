# Política de privacidad - Tabinet

Última actualización: 26 de noviembre de 2026

## Resumen

Tabinet es una extensión de Chrome que ordena y organiza las pestañas del navegador y te permite guardar, restaurar, buscar, importar y exportar conjuntos de ventanas y pestañas como sesiones. Si se lo pides, también pausa los vídeos de tus pestañas de YouTube, y te permite tomar notas con marcas de tiempo sobre un vídeo de YouTube en el panel lateral de Chrome, y escribir apuntes libres en su propia página. Tu privacidad nos importa: todo lo que hace la extensión ocurre dentro de tu navegador, en tu dispositivo, salvo que decidas iniciar sesión en la sincronización en la nube, que es opcional (consulta «Sincronización en la nube» más abajo).

## Recopilación de datos

Si no inicias sesión en la sincronización en la nube, Tabinet **no** recopila ni transmite ningún dato personal: no hace peticiones de red y todas las operaciones se realizan localmente en tu navegador. La sincronización en la nube es opcional y está desactivada hasta que inicias sesión; qué envía y cómo se protege se describe en «Sincronización en la nube» más abajo. En cualquier caso, la extensión no usa analíticas, rastreo ni telemetría, y no lee nada de las páginas que visitas salvo lo que se describe más abajo para YouTube. Solo ejecuta algo dentro de una página web en YouTube, y solo después de que lo permitas: la pausa de los vídeos y, para las notas de YouTube, la lectura del tiempo y el título del vídeo sobre el que tomas notas y, cuando lo pides, una captura de él (consulta «Pausar los vídeos de YouTube» y «Notas de YouTube» más abajo).

### Qué se guarda y dónde

Cuando guardas una sesión, y mientras las instantáneas automáticas están activadas (ver más abajo), la extensión guarda lo siguiente sobre tus ventanas abiertas en el almacenamiento local de extensiones de Chrome (`chrome.storage.local`) de este dispositivo:

- de cada pestaña: su URL, el título de la página, si está fijada y si era la pestaña activa
- de cada grupo de pestañas: su nombre, su color y si estaba contraído
- de cada ventana: su estado (normal, minimizada, maximizada o pantalla completa), su tamaño y posición, y si era la ventana con el foco
- de cada sesión: el nombre que le diste (o el generado por defecto), cuándo se guardó y cuándo cambió por última vez, y una huella breve de la disposición de sus pestañas que sirve para no guardar dos veces instantáneas idénticas
- de cada apunte: el texto que escribiste, cuándo se escribió y cuándo cambió por última vez y, en una copia guardada por un conflicto de sincronización, de qué apunte procede
- ajustes de sesiones: si las instantáneas automáticas están activadas, su intervalo, cuántas se conservan y cómo se gestionan las restauraciones grandes

Nunca se capturan las ventanas de incógnito, las ventanas vacías ni las páginas de la propia extensión. Los iconos de los sitios que se muestran en la página de Tabinet proceden de la caché de favicons de Chrome y la extensión no los guarda.

Sin la sincronización en la nube, estos datos y tus apuntes nunca salen de tu dispositivo: no se sincronizan con la sincronización de Chrome, no se suben a ningún servidor y las páginas web no pueden acceder a ellos. Los datos de sesiones solo salen de la extensión cuando tú lo decides: Exportar crea un archivo o copia texto al portapapeles, solo cuando tú lo pides expresamente, y, si inicias sesión en la sincronización en la nube, tus sesiones guardadas y tus apuntes (nunca tus instantáneas automáticas) se envían al servidor de sincronización cifradas de extremo a extremo, como se describe más abajo.

Tus preferencias de ordenación (el modo de agrupación y cómo se tratan las pestañas duplicadas) y el idioma que elegiste para la extensión en Configuración (si elegiste uno) se guardan en el almacenamiento sincronizado de Chrome, junto con el número de versión registrado al instalar o actualizar la extensión. Si tienes activada la sincronización de Chrome, esas preferencias, y nada más, pueden sincronizarse entre los dispositivos conectados a la misma cuenta de Chrome. Los datos y ajustes de sesiones nunca se guardan en el almacenamiento sincronizado de Chrome.

### Instantáneas automáticas

Las instantáneas automáticas están **activadas por defecto**. Cada 5 minutos (u otro intervalo que elijas, de 1 minuto a 24 horas), y cada vez que haces clic en el icono para ordenar, la extensión registra la disposición de tus ventanas abiertas tal como se describe arriba, pero solo si algo ha cambiado desde la última instantánea. Las instantáneas se guardan en el mismo almacenamiento local que las sesiones guardadas y siguen las mismas reglas.

Para desactivarlas, abre Tabinet (clic con el botón derecho en el icono → Opciones) y desactiva las instantáneas automáticas en Configuración. Con las instantáneas desactivadas no existe ningún temporizador de instantáneas (si has iniciado sesión en la sincronización en la nube, los temporizadores de sincronización siguen activos). La extensión sigue activándose brevemente cuando Chrome se inicia, cuando se instala o actualiza y cuando cambias un ajuste, para mantener en orden sus propios datos guardados. Sin la sincronización en la nube, nada de eso usa la red. Si has iniciado sesión en ella, un ajuste modificado se envía en pocos segundos (salvo que la sincronización esté fallando: entonces, en el siguiente intento, hasta 15 minutos después) y los cambios pendientes se envían después de que Chrome se inicie.

### Pausar los vídeos de YouTube

«Pausar todos los vídeos de YouTube», en el menú contextual del icono y como combinación de teclas, pausa todos los vídeos y audios que se estén reproduciendo en tus pestañas de YouTube abiertas, en todas las ventanas. Cada vídeo conserva su posición; nada se silencia, se cierra ni se recarga.

Para ello la extensión necesita acceso a youtube.com (`https://*.youtube.com/*`, que incluye www, m y music). Nunca se solicita al instalarla: Chrome te lo pregunta cuando activas «Acceso a YouTube» en Configuración (si eliges antes el elemento del menú, se abre Configuración), y puedes quitar el acceso allí, o en chrome://extensions, cuando quieras. Con ese acceso, cada vez que lo pides, la extensión ejecuta en cada pestaña de YouTube una pequeña función que forma parte de la propia extensión: pulsa pausa y cuenta cuántos vídeos ha pausado. No lee la página, lo que ves ni nada más de YouTube, y no guarda ni transmite nada sobre YouTube. Sin ese acceso, no se ejecuta nada en ninguna página web.

### Notas de YouTube

«Notas de YouTube» (en el menú contextual del icono, como combinación de teclas que puedes asignar y como botón en la página de Tabinet) abre el panel lateral de Chrome junto a la página. Mientras la pestaña activa de esa ventana muestra un vídeo de YouTube, puedes escribir notas sobre él, cada una en un momento del vídeo, y hacer clic en el tiempo de una nota para que el vídeo salte allí.

Por cada vídeo sobre el que tomas notas, la extensión guarda en el almacenamiento local de extensiones (`chrome.storage.local`) de este dispositivo: el identificador y la dirección del vídeo (`https://www.youtube.com/watch?v=<id>`), su título, el texto de cada nota con el momento del vídeo al que corresponde, las capturas que hagas para una nota (una imagen del fotograma del vídeo, de 1280 píxeles de ancho como máximo), y cuándo se escribió y se modificó por última vez cada nota. Al eliminar una nota se elimina también su captura. Sin la sincronización en la nube, las notas nunca salen de tu dispositivo. Si inicias sesión en la sincronización en la nube, cada nota se sincroniza como un elemento propio cifrado de extremo a extremo, con su captura; el identificador y el título del vídeo solo están dentro del contenido cifrado (consulta «Sincronización en la nube» más abajo).

Para funcionar, el panel necesita el mismo acceso a youtube.com que la pausa (consulta arriba), que pide con el mismo interruptor «Acceso a YouTube». Con él, mientras el panel está abierto sobre un vídeo, una pequeña función que forma parte de la extensión lee el tiempo actual del vídeo, su duración, si se está reproduciendo y el título de la página, aproximadamente una vez por segundo mientras el panel está visible; cuando lo pides, lleva el vídeo al tiempo de una nota y, si dejas activado «Pausar el vídeo mientras escribo», lo pausa mientras escribes una nota y lo vuelve a reproducir después. Cuando pulsas Captura, convierte en una imagen el fotograma que muestra el vídeo en ese momento y se la pasa al panel, que la guarda con una nota nueva. No lee nada más de la página, y lo que lee no se guarda salvo como parte de una nota que guardes.

### Sincronización en la nube (opcional)

La sincronización en la nube mantiene iguales tus sesiones guardadas, apuntes, notas de YouTube y ajustes en todos los ordenadores donde usas Tabinet. Está **desactivada hasta que inicias sesión**: abre Configuración, Cuenta, y haz clic en «Iniciar sesión con Google». Si nunca lo haces, nada de esta sección se aplica y la extensión no hace ninguna petición de red. Las versiones anteriores a la 10 ya no pueden sincronizar. Los datos sincronizados por esas versiones se borraron cuando arrancó el servidor de la versión 10; los datos de tus dispositivos no.

**Inicio de sesión.** Chrome da a la extensión un token de acceso de Google limitado a los ámbitos `openid` y `email`: tu dirección de correo y el identificador estable de tu cuenta de Google. La extensión lo envía al servidor de sincronización de Tabinet, que lo comprueba con Google y lo olvida, y la extensión lo borra de la caché de Chrome. La misma comprobación se repite cuando creas, escribes o cambias la frase de contraseña de sincronización y cuando eliminas tus datos de la nube. El servidor da a tu navegador un token de sesión válido durante 90 días. Si este dispositivo se sincronizó por última vez con otra cuenta, la extensión pregunta antes de subir sus datos a la nueva.

**Claves.** Tu primer dispositivo crea una clave de datos aleatoria, con la que se cifra todo lo que se sincroniza (AES-GCM de 256 bits). La propia clave de datos se cifra en tu dispositivo con una clave derivada de tu frase de contraseña (PBKDF2 con SHA-256, 600.000 rondas y una sal aleatoria). El servidor recibe solo esa clave cifrada, la vuelve a sellar con una clave propia y solo la entrega después de que Google confirme tu cuenta. La frase de contraseña y la clave de datos nunca se envían. Lo que guarda la versión 10 no contiene nada con lo que probar una frase de contraseña sin la clave propia del servidor. El historial de recuperación del proveedor de la base de datos puede conservar durante un tiempo limitado los registros de frase de contraseña de la versión 9, así que elige una frase que nunca hayas usado antes para sincronizar. Quien controle el servidor y tenga su clave y su base de datos, o quien pueda iniciar sesión como tú en Google, podría intentar adivinar tu frase de contraseña, así que elige una robusta y distinta de tu contraseña de Google.

La clave de datos se queda en el almacenamiento local de la extensión en cada dispositivo desbloqueado, también cuando caduca el inicio de sesión, hasta que cierras sesión, eliminas allí los datos de la nube o la sustituyes por la de otra cuenta. Cualquiera con acceso a ese perfil del navegador o a su copia de seguridad podría leerla. Un dispositivo desbloqueado puede poner una frase de contraseña nueva tras una comprobación de Google, sin la anterior. Cambiar la frase de contraseña no cambia la clave de datos, así que no retira el acceso a quien ya tenga esa clave. Eliminar los datos de la nube y empezar de nuevo sí lo hace.

**Qué se envía, cifrado.**

- tus sesiones guardadas, con las URL y los títulos de sus pestañas, sus grupos de pestañas y la disposición de sus ventanas, y sus eliminaciones
- tus apuntes y sus eliminaciones
- tus notas de YouTube, un elemento por nota: el identificador y el título del vídeo, el texto y el momento de la nota, y sus eliminaciones
- las capturas que hiciste para las notas, y sus eliminaciones
- tus ajustes: preferencias de ordenación, ajustes de sesiones e idioma

Las instantáneas automáticas **nunca** se sincronizan. Una cuenta admite hasta 50 MB de datos cifrados, incluidas las marcas de eliminación, y hasta 100 capturas. Lo que no cabe se queda en el dispositivo y la extensión te avisa. Eliminar siempre funciona.

**Qué guarda el servidor y qué puede ver.** De tu cuenta: la dirección de correo, el identificador de la cuenta de Google, cuándo se creó, la clave sellada, un identificador y un número de cambio de esa clave, un hash que solo permite sustituirla a quien tenga la clave de datos, y cuánto almacenamiento usas. De cada inicio de sesión: un hash del token de sesión y cuándo caduca. De cada elemento: el contenido cifrado, si es una sesión, los ajustes, una captura o un documento, un identificador aleatorio u opaco, su tamaño, cuándo cambió y si se eliminó. Los apuntes y las notas se parecen salvo por el tamaño. El identificador del vídeo nunca está fuera del contenido cifrado. Sin tu clave de datos nadie puede leer ni falsificar un elemento. Quien controle el servidor, o tenga uno de tus tokens de sesión, podría retener, sobrescribir, eliminar o devolver elementos a una versión anterior.

**Dónde.** El servidor de sincronización funciona en Vercel y su base de datos en Neon, ambos en la región de Singapur. Actúan como proveedores de alojamiento. Vercel puede registrar en sus logs información habitual de las peticiones, como las direcciones IP. Google comprueba los tokens de acceso.

**Conservación y eliminación.** Los datos sincronizados y las marcas de eliminación se conservan hasta que los eliminas. «Eliminar datos de la nube» en Configuración, Cuenta elimina tu cuenta y todo lo guardado para ella de la base de datos activa tras una comprobación de Google. El historial de recuperación del proveedor de la base de datos puede conservarlo durante un tiempo limitado después. Los datos de tus dispositivos se quedan. «Cerrar sesión» olvida el token de sesión y la clave de datos de ese dispositivo y deja la copia en la nube.

**Uso.** Los datos sincronizados se usan solo para sincronizar tus propios dispositivos. Nunca se venden, ni se usan para publicidad, analíticas o elaboración de perfiles, ni se comparten más allá de los proveedores indicados.

## Conservación de datos

- Las sesiones guardadas se conservan hasta que las borras en la página de Tabinet.
- Las instantáneas automáticas se conservan en un conjunto rotativo: solo se mantienen las instantáneas no protegidas más recientes (20 por defecto; eliges cuántas en la configuración de la página de Tabinet) y las más antiguas se eliminan automáticamente. Una instantánea que marques como protegida se conserva hasta que la borres. La instantánea «Sesión anterior (recuperada)» que se crea tras reiniciar el navegador se protege automáticamente, igual que la anterior; las instantáneas recuperadas más antiguas vuelven al conjunto rotativo y caducan como cualquier otra. Las que protejas tú se conservan mientras quieras. Las instantáneas se pueden borrar una a una o todas a la vez.
- Los apuntes se conservan hasta que los borras en la página de Tabinet; tras eliminar uno, se ofrece Deshacer durante unos segundos.
- «Eliminar todos los datos de sesiones» en la página de Tabinet elimina de inmediato todas las sesiones guardadas e instantáneas; tus ajustes, tus notas de YouTube y tus apuntes se conservan.
- Las notas de YouTube se conservan hasta que las borras en el panel de notas o en la página de Tabinet; al borrar la última nota de un vídeo se elimina todo lo guardado sobre ese vídeo.
- Al desinstalar la extensión, Chrome elimina todos sus datos guardados en ese dispositivo. Los datos del servidor de sincronización, si iniciaste sesión, se conservan hasta que los elimines con «Eliminar datos de la nube» (vuelve a iniciar sesión para llegar a ese botón).

## Permisos

Esta extensión necesita los siguientes permisos:

- **tabs**: para leer las URL y los títulos de las pestañas al ordenarlas, al guardar sesiones y para la lista de ventanas abiertas de la página de Tabinet, y para crear pestañas al restaurar una sesión.
- **tabGroups**: para ordenar y organizar los grupos de pestañas de la ventana actual y para volver a crearlos al restaurar una sesión.
- **storage**: para guardar tus preferencias de ordenación y el idioma elegido en el almacenamiento sincronizado de Chrome, y para guardar las sesiones, instantáneas, ajustes de sesiones, notas de YouTube, apuntes y, si usas la sincronización en la nube, su token de sesión, su clave de datos y sus datos de control en el almacenamiento local de este dispositivo.
- **contextMenus**: para agregar «¡Reunir!», «Guardar todas las ventanas como sesión», «Pausar todos los vídeos de YouTube» y «Notas de YouTube» al menú contextual del icono de la extensión. No se agrega ningún elemento de menú a las páginas web.
- **unlimitedStorage**: permite que las sesiones grandes superen la cuota predeterminada del almacenamiento local de Chrome. No cambia dónde se guardan los datos y no envía nada a ningún sitio.
- **favicon**: para mostrar, junto a las pestañas de la página de Tabinet, los iconos de los sitios desde la caché local de favicons de Chrome. No se descarga ningún icono de la red y la extensión no guarda datos de iconos.
- **alarms**: se usa como temporizador de las instantáneas automáticas, con el intervalo que elijas, y, mientras tienes iniciada la sesión de sincronización en la nube, para buscar cambios cada 15 minutos, enviar un cambio si Chrome detuvo la extensión antes de que pudiera hacerlo y reintentar una sincronización fallida. Con las instantáneas automáticas desactivadas y sin sesión iniciada, no existe ningún temporizador.
- **identity**: solo para la sincronización en la nube, cuando haces clic en «Iniciar sesión con Google», y para confirmar tu cuenta cuando creas, escribes o cambias la frase de contraseña o eliminas los datos de la nube: pide a Chrome un token de acceso de Google con los ámbitos `openid` y `email`, como se describe en «Sincronización en la nube». Si no inicias sesión, nunca se usa.
- **scripting**: solo en YouTube: para pausar los vídeos cuando lo pides, como se describe en «Pausar los vídeos de YouTube», y, para las notas de YouTube, para leer el tiempo y el título del vídeo, llevarlo al tiempo de una nota y hacer una captura cuando lo pides, como se describe en «Notas de YouTube». Solo funciona en los sitios que permitas a continuación.
- **sidePanel**: para mostrar las notas de YouTube en el panel lateral de Chrome cuando lo abres desde el menú contextual, su combinación de teclas o la página de Tabinet. Hacer clic en el icono nunca lo abre.
- **Acceso a youtube.com** (opcional, `https://*.youtube.com/*`): se solicita solo cuando activas «Acceso a YouTube» en Configuración o en el panel de notas, y se puede quitar en Configuración. Se usa solo para pausar vídeos y, para las notas de YouTube, para leer el tiempo y el título del vídeo, moverlo y hacer una captura cuando lo pides; no se lee nada más de las páginas de YouTube.

La extensión no solicita permisos de host al instalarla ni declara scripts de contenido; el acceso a youtube.com es opcional y solo tú decides concederlo. Necesita Chrome 123 o posterior.

## Uso de los datos

- Las URL y los títulos de las pestañas se leen al ordenar y **no** se guardan como parte de la ordenación.
- Cuando guardas una sesión, o mientras las instantáneas automáticas están activadas, los datos indicados arriba se guardan en el almacenamiento local de extensiones de tu dispositivo. Los apuntes que escribes también se guardan ahí. Estos datos solo se transmiten si inicias sesión en la sincronización en la nube, y entonces solo tus sesiones guardadas, tus apuntes, tus notas de YouTube con sus capturas y tu configuración, cifradas de extremo a extremo; las instantáneas automáticas, nunca.
- Las preferencias de ordenación se guardan con la API de almacenamiento integrada de Chrome; con la sincronización en la nube también van, cifradas, al servidor de sincronización. Nunca se comparten con terceros.
- Nada se vende, se comparte ni se usa para otro fin que no sea ordenar pestañas, pausar los vídeos de YouTube cuando lo pides, guardar tus notas sobre vídeos de YouTube y tus apuntes, y guardar, restaurar, buscar, importar, exportar y, si inicias sesión, sincronizar sesiones, apuntes y notas.

## Servicios de terceros

Tabinet **no** usa servicios de terceros de analítica, rastreo ni recopilación de datos. La sincronización en la nube, solo si inicias sesión, usa el inicio de sesión de Google y los proveedores de alojamiento Vercel y Neon, como se describe en «Sincronización en la nube».

## Cambios en esta política

Podemos actualizar esta política de privacidad de vez en cuando. Cualquier cambio se publicará en esta página con una nueva fecha de "Última actualización".

## Contacto

Si tienes alguna pregunta sobre esta política de privacidad, abre una incidencia en el [repositorio de GitHub](https://github.com/thilllon/tabinet/issues).
