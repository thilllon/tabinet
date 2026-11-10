# Política de privacidad - Tabinet

Última actualización: 10 de noviembre de 2026

## Resumen

Tabinet es una extensión de Chrome que ordena y organiza las pestañas del navegador y te permite guardar, restaurar, buscar, importar y exportar conjuntos de ventanas y pestañas como sesiones. Si se lo pides, también pausa los vídeos de tus pestañas de YouTube. Tu privacidad nos importa: todo lo que hace la extensión ocurre dentro de tu navegador, en tu dispositivo, salvo que decidas iniciar sesión en la sincronización en la nube, que es opcional (consulta «Sincronización en la nube» más abajo).

## Recopilación de datos

Si no inicias sesión en la sincronización en la nube, Tabinet **no** recopila ni transmite ningún dato personal: no hace peticiones de red y todas las operaciones se realizan localmente en tu navegador. La sincronización en la nube es opcional y está desactivada hasta que inicias sesión; qué envía y cómo se protege se describe en «Sincronización en la nube» más abajo. En cualquier caso, la extensión no lee nada de las páginas que visitas y no usa analíticas, rastreo ni telemetría. Lo único que ejecuta dentro de una página web es la pausa de los vídeos de YouTube, y solo después de que lo permitas (consulta «Pausar los vídeos de YouTube» más abajo).

### Qué se guarda y dónde

Cuando guardas una sesión, y mientras las instantáneas automáticas están activadas (ver más abajo), la extensión guarda lo siguiente sobre tus ventanas abiertas en el almacenamiento local de extensiones de Chrome (`chrome.storage.local`) de este dispositivo:

- de cada pestaña: su URL, el título de la página, si está fijada y si era la pestaña activa
- de cada grupo de pestañas: su nombre, su color y si estaba contraído
- de cada ventana: su estado (normal, minimizada, maximizada o pantalla completa), su tamaño y posición, y si era la ventana con el foco
- de cada sesión: el nombre que le diste (o el generado por defecto), cuándo se guardó y cuándo cambió por última vez, y una huella breve de la disposición de sus pestañas que sirve para no guardar dos veces instantáneas idénticas
- ajustes de sesiones: si las instantáneas automáticas están activadas, su intervalo, cuántas se conservan y cómo se gestionan las restauraciones grandes

Nunca se capturan las ventanas de incógnito, las ventanas vacías ni las páginas de la propia extensión. Los iconos de los sitios que se muestran en la página de Tabinet proceden de la caché de favicons de Chrome y la extensión no los guarda.

Sin la sincronización en la nube, estos datos nunca salen de tu dispositivo: no se sincronizan con la sincronización de Chrome, no se suben a ningún servidor y las páginas web no pueden acceder a ellos. Los datos de sesiones solo salen de la extensión cuando tú lo decides: Exportar crea un archivo o copia texto al portapapeles, solo cuando tú lo pides expresamente, y, si inicias sesión en la sincronización en la nube, tus sesiones guardadas (nunca tus instantáneas automáticas) se envían al servidor de sincronización cifradas de extremo a extremo, como se describe más abajo.

Tus preferencias de ordenación (el modo de agrupación y cómo se tratan las pestañas duplicadas) y el idioma que elegiste para la extensión en Configuración (si elegiste uno) se guardan en el almacenamiento sincronizado de Chrome, junto con el número de versión registrado al instalar o actualizar la extensión. Si tienes activada la sincronización de Chrome, esas preferencias, y nada más, pueden sincronizarse entre los dispositivos conectados a la misma cuenta de Chrome. Los datos y ajustes de sesiones nunca se guardan en el almacenamiento sincronizado de Chrome.

### Instantáneas automáticas

Las instantáneas automáticas están **activadas por defecto**. Cada 5 minutos (u otro intervalo que elijas, de 1 minuto a 24 horas), y cada vez que haces clic en el icono para ordenar, la extensión registra la disposición de tus ventanas abiertas tal como se describe arriba, pero solo si algo ha cambiado desde la última instantánea. Las instantáneas se guardan en el mismo almacenamiento local que las sesiones guardadas y siguen las mismas reglas.

Para desactivarlas, abre Tabinet (clic con el botón derecho en el icono → Opciones) y desactiva las instantáneas automáticas en Configuración. Con las instantáneas desactivadas no existe ningún temporizador. La extensión sigue activándose brevemente cuando Chrome se inicia, cuando se instala o actualiza y cuando cambias un ajuste, para mantener en orden sus propios datos guardados; nada de eso usa la red.

### Pausar los vídeos de YouTube

«Pausar todos los vídeos de YouTube», en el menú contextual del icono y como combinación de teclas, pausa todos los vídeos y audios que se estén reproduciendo en tus pestañas de YouTube abiertas, en todas las ventanas. Cada vídeo conserva su posición; nada se silencia, se cierra ni se recarga.

Para ello la extensión necesita acceso a youtube.com (`https://*.youtube.com/*`, que incluye www, m y music). Nunca se solicita al instalarla: Chrome te lo pregunta cuando activas «Acceso a YouTube» en Configuración (si eliges antes el elemento del menú, se abre Configuración), y puedes quitar el acceso allí, o en chrome://extensions, cuando quieras. Con ese acceso, cada vez que lo pides, la extensión ejecuta en cada pestaña de YouTube una pequeña función que forma parte de la propia extensión: pulsa pausa y cuenta cuántos vídeos ha pausado. No lee la página, lo que ves ni nada más de YouTube, y no guarda ni transmite nada sobre YouTube. Sin ese acceso, no se ejecuta nada en ninguna página web.

### Sincronización en la nube (opcional)

La sincronización en la nube mantiene iguales tus sesiones guardadas y tu configuración en todos los ordenadores donde usas Tabinet. Está **desactivada hasta que inicias sesión**: abre Configuración, Cuenta, y haz clic en «Iniciar sesión con Google». Si nunca lo haces, nada de esta sección se aplica y la extensión no hace ninguna petición de red.

**Inicio de sesión.** Chrome te pide permiso y luego entrega a la extensión un token de acceso de Google para la cuenta de Google con la que has iniciado sesión en Chrome, limitado a los ámbitos `openid` y `email`: tu dirección de correo y el identificador estable de tu cuenta de Google, nada más de tu cuenta. La extensión envía ese token una sola vez al servidor de sincronización de Tabinet, que lo comprueba con Google y después lo olvida; la extensión lo quita de la caché de Chrome justo después. Luego el servidor entrega a tu navegador su propio token de sesión, válido durante 90 días, que la extensión guarda en el almacenamiento local de extensiones.

**Qué se envía y cómo se protege.** Antes de enviar cualquier sesión o configuración, creas una frase de contraseña de sincronización. A partir de ella se deriva una clave en tu dispositivo (PBKDF2 con SHA-256, 600.000 iteraciones y una sal aleatoria) y todo lo sincronizado se cifra con esa clave mediante AES-GCM (256 bits). La frase de contraseña y la clave nunca se envían a ningún sitio. Lo que se envía, cifrado:

- tus sesiones guardadas, con las URL y los títulos de sus pestañas, sus grupos de pestañas y la disposición de sus ventanas, y las eliminaciones de sesiones guardadas
- tu configuración: preferencias de ordenación, ajustes de sesiones y el idioma que elegiste

Las instantáneas automáticas **nunca** se sincronizan. Como el servidor nunca tiene tu frase de contraseña ni tu clave, no puede leer tus sesiones ni tu configuración, y nadie, tampoco nosotros, puede recuperarlas si olvidas la frase de contraseña (las sesiones de tus dispositivos no se ven afectadas).

**Qué guarda el servidor.** De tu cuenta: tu dirección de correo, el identificador de tu cuenta de Google, cuándo se creó la cuenta y los datos que tus dispositivos necesitan para comprobar una frase de contraseña (la sal, el número de iteraciones y un valor de comprobación cifrado, ninguno de los cuales revela la frase). De cada inicio de sesión: un hash del token de sesión (nunca el token) y cuándo caduca. De cada elemento sincronizado: el contenido cifrado, si es una sesión o la configuración, un identificador aleatorio, cuándo cambió por última vez y si se eliminó. Una sesión que eliminas se queda en el servidor como una marca de eliminación cifrada, para que tus otros dispositivos se enteren, hasta que eliminas tus datos de la nube.

**Dónde.** El servidor de sincronización funciona en Vercel y su base de datos en Neon, ambos en la región de Singapur (Asia-Pacífico). Actúan como nuestros proveedores de alojamiento y tratan estos datos solo para prestar el servicio; al atender las peticiones, Vercel puede registrar información habitual de las peticiones, como direcciones IP. Al iniciar sesión también interviene Google, que comprueba el token de acceso.

**Conservación y eliminación.** Los datos sincronizados se conservan hasta que los eliminas. «Eliminar datos de la nube», en Configuración, Cuenta, elimina tu cuenta y todo lo que se guarda para ella en el servidor, de inmediato y para siempre; las sesiones de tus dispositivos se conservan. «Cerrar sesión» detiene la sincronización en ese dispositivo y olvida su token de sesión y su clave, pero deja tus datos en el servidor para tus otros dispositivos. Un token de sesión caduca 90 días después de iniciar sesión; para seguir, vuelve a iniciar sesión.

**Uso.** Los datos sincronizados se usan solo para sincronizar tus propios dispositivos. Nunca se venden, nunca se usan para publicidad, analíticas ni elaboración de perfiles, y nunca se comparten con nadie salvo los proveedores de alojamiento indicados, para prestar el servicio.

## Conservación de datos

- Las sesiones guardadas se conservan hasta que las borras en la página de Tabinet.
- Las instantáneas automáticas se conservan en un conjunto rotativo: solo se mantienen las instantáneas no protegidas más recientes (20 por defecto; eliges cuántas en la configuración de la página de Tabinet) y las más antiguas se eliminan automáticamente. Una instantánea que marques como protegida se conserva hasta que la borres. La instantánea «Sesión anterior (recuperada)» que se crea tras reiniciar el navegador se protege automáticamente, igual que la anterior; las instantáneas recuperadas más antiguas vuelven al conjunto rotativo y caducan como cualquier otra. Las que protejas tú se conservan mientras quieras. Las instantáneas se pueden borrar una a una o todas a la vez.
- «Eliminar todos los datos de sesiones» en la página de Tabinet elimina de inmediato todas las sesiones guardadas e instantáneas; tus ajustes se conservan.
- Al desinstalar la extensión, Chrome elimina todos sus datos guardados en ese dispositivo. Los datos del servidor de sincronización, si iniciaste sesión, se conservan hasta que los elimines con «Eliminar datos de la nube» (vuelve a iniciar sesión para llegar a ese botón).

## Permisos

Esta extensión necesita los siguientes permisos:

- **tabs**: para leer las URL y los títulos de las pestañas al ordenarlas, al guardar sesiones y para la lista de ventanas abiertas de la página de Tabinet, y para crear pestañas al restaurar una sesión.
- **tabGroups**: para ordenar y organizar los grupos de pestañas de la ventana actual y para volver a crearlos al restaurar una sesión.
- **storage**: para guardar tus preferencias de ordenación y el idioma elegido en el almacenamiento sincronizado de Chrome, y para guardar las sesiones, instantáneas, ajustes de sesiones y, si usas la sincronización en la nube, su token de sesión y su clave en el almacenamiento local de este dispositivo.
- **contextMenus**: para agregar «¡Reunir!», «Guardar todas las ventanas como sesión» y «Pausar todos los vídeos de YouTube» al menú contextual del icono de la extensión. No se agrega ningún elemento de menú a las páginas web.
- **unlimitedStorage**: permite que las sesiones grandes superen la cuota predeterminada del almacenamiento local de Chrome. No cambia dónde se guardan los datos y no envía nada a ningún sitio.
- **favicon**: para mostrar, junto a las pestañas de la página de Tabinet, los iconos de los sitios desde la caché local de favicons de Chrome. No se descarga ningún icono de la red y la extensión no guarda datos de iconos.
- **alarms**: se usa como temporizador de las instantáneas automáticas, con el intervalo que elijas, y, mientras tienes iniciada la sesión de sincronización en la nube, para sincronizar cada 15 minutos y poco después de cada cambio. Con las instantáneas automáticas desactivadas y sin sesión iniciada, no existe ningún temporizador.
- **identity**: solo para la sincronización en la nube, cuando haces clic en «Iniciar sesión con Google»: pide a Chrome un token de acceso de Google con los ámbitos `openid` y `email`, como se describe en «Sincronización en la nube». Si no inicias sesión, nunca se usa.
- **scripting**: solo para pausar los vídeos de YouTube cuando lo pides, como se describe en «Pausar los vídeos de YouTube». Solo funciona en los sitios que permitas a continuación.
- **Acceso a youtube.com** (opcional, `https://*.youtube.com/*`): se solicita solo cuando activas «Acceso a YouTube» en Configuración, y se puede quitar allí. Se usa solo para pausar vídeos; no se lee nada de las páginas de YouTube.

La extensión no solicita permisos de host al instalarla ni declara scripts de contenido; el acceso a youtube.com es opcional y solo tú decides concederlo. Necesita Chrome 123 o posterior.

## Uso de los datos

- Las URL y los títulos de las pestañas se leen al ordenar y **no** se guardan como parte de la ordenación.
- Cuando guardas una sesión, o mientras las instantáneas automáticas están activadas, los datos indicados arriba se guardan en el almacenamiento local de extensiones de tu dispositivo. Solo se transmiten si inicias sesión en la sincronización en la nube, y entonces solo tus sesiones guardadas y tu configuración, cifradas de extremo a extremo; las instantáneas automáticas, nunca.
- Las preferencias de ordenación se guardan con la API de almacenamiento integrada de Chrome; con la sincronización en la nube también van, cifradas, al servidor de sincronización. Nunca se comparten con terceros.
- Nada se vende, se comparte ni se usa para otro fin que no sea ordenar pestañas, pausar los vídeos de YouTube cuando lo pides, y guardar, restaurar, buscar, importar, exportar y, si inicias sesión, sincronizar sesiones.

## Servicios de terceros

Tabinet **no** usa servicios de terceros de analítica, rastreo ni recopilación de datos. La sincronización en la nube, solo si inicias sesión, usa el inicio de sesión de Google y los proveedores de alojamiento Vercel y Neon, como se describe en «Sincronización en la nube».

## Cambios en esta política

Podemos actualizar esta política de privacidad de vez en cuando. Cualquier cambio se publicará en esta página con una nueva fecha de "Última actualización".

## Contacto

Si tienes alguna pregunta sobre esta política de privacidad, abre una incidencia en el [repositorio de GitHub](https://github.com/thilllon/tabinet/issues).
