# 🐙 Pulpo

Cliente de GitHub para Mac centrado en pull requests, con un listado al estilo Bitbucket:
estado, `rama-origen → rama-destino`, checks, revisiones y acciones de un clic.

**Reglas de la casa (no configurables, a propósito):**

| Operación | Método |
|---|---|
| Update branch | **rebase** |
| Merge | **merge commit** |
| Squash | **jamás** (no existe en la UI ni en el código) |

## Ejecutar

```bash
cd pulpo
npm install        # primera vez (descarga Electron)
npm start
```

## Token de GitHub

La app no guarda tu token salvo que tú lo pidas. Orden de resolución:

1. Variable de entorno `GITHUB_TOKEN`
2. `gh auth token` (GitHub CLI — lo habitual)
3. Token manual guardado desde Ajustes ⚙ (en `~/Library/Application Support/pulpo/config.json`, permisos 600)

## Qué hace

- **Listado de PRs** por repositorio (configurable en Ajustes; por defecto `Uriach/zinc`):
  título, autor, `head → base`, estado (Abierta/Borrador/Fusionada/Cerrada), decisión de
  revisión (Aprobada / Cambios pedidos / Falta revisión), checks (✓/✗/●), rama atrasada o
  con conflictos, comentarios y antigüedad.
- **Buckets**: Abiertas · Mías · Para revisar · Borradores · Fusionadas · Cerradas. Búsqueda libre.
- **Detalle**: descripción renderizada (HTML de GitHub), checks con enlace, revisores y su estado,
  +/− y ficheros tocados.
- **Acciones**: *Update branch (rebase)*, *Merge (merge commit)* con confirmación y opción de
  borrar la rama, *Abrir en GitHub*.
- Refresco automático (60 s por defecto) y manual (`R` o ⟳). Modo claro/oscuro según el sistema.

## Selftest

`npm run selftest` arranca la app, espera el primer render con datos reales, guarda una captura
en `/tmp/pulpo-selftest.png` y sale. Útil para verificar la app sin interacción.

## Empaquetar como .app (opcional)

No es necesario para el uso diario (`npm start` basta). Si quieres un `.app` en Aplicaciones:

```bash
npx electron-packager . Pulpo --platform=darwin --arch=arm64 --out=dist
```
