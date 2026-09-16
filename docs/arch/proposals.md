# Bandeja de propuestas (Outlook → Epic)

Lee la bandeja de correo donde negocio manda propuestas de nuevas funcionalidades y las convierte,
con IA, en una **Epic de GitLab con sus tareas hijas**. Solo GitLab (las Epics no existen en GitHub).

Piezas: `src/mail.js` (Graph), `ai.proposeFromEmail` (`src/ai.js`), `src/ipc/mail.js` (handlers) y
`renderer/app/proposals.js` (vista, sección `propuestas`).

## Auth: device code flow

Sin servidor local de redirect, sin redirect URI que registrar y sin MSAL — dos POST y polling
contra `login.microsoftonline.com/{tenant}/oauth2/v2.0`:

1. `mail:startLogin` → `/devicecode` devuelve `user_code` + `verification_uri`.
2. El usuario abre la URL y teclea el código.
3. `mail:pollLogin` canjea contra `/token`; mientras no haya autorizado devuelve `{pending:true}`.

**El polling lo lleva el renderer**, no el main: un handler IPC bloqueado varios minutos esperando a
que alguien teclee un código dejaría la ventana sin responder.

Microsoft **rota el refresh token en cada canje**. Si no se guarda el nuevo en cada refresco, la
sesión caduca sola a los pocos días — `accessToken()` lo persiste siempre que viene uno.

### Requisito por instalación

Un *app registration* en Azure AD marcado como **public client** ("Allow public client flows" = sí)
con el permiso **delegado** `Mail.ReadWrite`. El `clientId`, el `tenant` y la carpeta se configuran
en Ajustes → Bandeja de propuestas. Sin `clientId` la vista solo muestra el aviso de configuración.

El `tenant` es **obligatorio** si la app es de un solo inquilino (la opción por defecto del portal):
contra `common` u `organizations` Azure responde AADSTS50059, y `postForm` lo traduce a un aviso que
manda a Ajustes. `common` solo vale para apps registradas como multiinquilino.

Sin «Permitir flujos de cliente público», `/devicecode` **sí funciona** y el polling devuelve
`authorization_pending` con normalidad: el fallo solo llega cuando el usuario ya ha autorizado y
`/token` canjea de verdad — AADSTS7000218 (pide `client_secret`). Engaña porque todo parece ir bien
hasta el último paso.

Los seis pasos del portal de Azure están **dentro de la app**, en el `<details>` de esa misma
tarjeta, con un botón que abre el deep link a *App registrations*
(`--selftest-route=ajustes-propuestas` los captura). Si cambian los menús del portal, ese es el
único sitio que hay que tocar.

Es `Mail.ReadWrite` y no `Mail.Read` porque al crear la Epic el correo se marca como leído.

## Estado "ya procesado"

No hay lista local de correos vistos: se leen solo los **no leídos** (`$filter=isRead eq false`) y al
crear la Epic se marca el correo como leído. La señal vive en el propio Outlook, se ve desde
cualquier cliente y no se desincroniza.

El marcado va **al final** de `mail:create` y solo si alguna tarea se creó: si algo revienta antes,
el correo sigue apareciendo pendiente.

## Cuerpo del correo

Graph devuelve HTML por defecto. La petición manda `Prefer: outlook.body-content-type="text"` y
llega texto plano — nada de parsear HTML antes de dárselo al modelo.

## La IA no crea nada

`mail:propose` devuelve un **borrador**; solo `mail:create`, tras un click explícito, escribe en
GitLab (hard rule de "nunca auto-publicar"). En el borrador se pueden editar título y descripción de
la Epic y **descartar tareas** con los checkboxes — la IA a veces mete proyectos de más.

El `projectPath` de cada tarea va como **`enum` en el schema** con los proyectos reales de
`groupProjects()`, así el modelo no puede inventarse un path; el handler además vuelve a filtrar.

## Tripwires

- `config.mail.refreshToken` **nunca sale al renderer**: `config:get` lo quita a mano, igual que el
  token del proveedor. Si añades una clave nueva a `config.mail`, revisa ese desestructurado.
- `config:set` solo acepta `clientId`, `tenant` y `folder`. El `refreshToken` lo escribe `mail.js`.
- La creación de tareas es **secuencial y no atómica**, como el resto de mutaciones batch de GitLab:
  si la Epic falla no se sigue; cada tarea se reporta por separado en `results`.
- Las carpetas son rutas `Padre/Hija` con **un solo nivel** de subcarpetas (`$expand=childFolders`,
  que no anida más). `mailFolders()` alimenta tanto el desplegable de Ajustes (`mail:folders`) como
  `folderId()`. Para ir más hondo habría que recorrer `/childFolders` a mano.
- `folderId()` busca primero por ruta y solo después prueba el nombre como well-known de Graph
  (`inbox`…): así una carpeta propia en minúsculas no se confunde con una well-known.
- Al ser una sección nueva, las instalaciones con `config.sections` ya guardado **no la ven** hasta
  activarla en Ajustes → Apartados del menú.
