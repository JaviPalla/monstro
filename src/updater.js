"use strict";

/**
 * Actualización de la propia app desde sus Releases de GitHub (repo público, sin token: es
 * independiente del proveedor configurado).
 *
 * Es HÍBRIDA por plataforma, y no por capricho:
 *
 * - **Windows**: update real vía electron-updater (NSIS + `latest.yml`). Descarga y al reiniciar
 *   queda instalada. Sin firma no hay problema: solo salta el aviso de SmartScreen.
 * - **macOS**: NO se puede hacer update in-place. El auto-update de macOS va por Squirrel.Mac,
 *   que valida la firma del zip descargado y exige la MISMA identidad válida que la app
 *   instalada; Monstro se firma **ad-hoc** (`scripts/adhoc-sign.js`, sin Team ID), así que
 *   Squirrel rechazaría el update con "Code signature did not pass validation". Necesitaría un
 *   certificado Developer ID + notarización (cuenta de Apple Developer). Mientras no lo haya,
 *   aquí bajamos el .dmg y lo abrimos: el usuario solo arrastra a Aplicaciones.
 *
 * Si algún día se firma y notariza de verdad, este módulo se simplifica a `installWindows` para
 * las dos plataformas y `pickMacAsset`/`download` se borran.
 *
 * OJO con el pipeline: electron-updater NO consulta la API de GitHub, lee el `latest.yml` que
 * electron-builder solo genera si existe `build.publish` en package.json (está por eso, no para
 * que publique — de la release sigue encargándose softprops con `--publish never`). release.yml
 * sube `dist/latest.yml` junto al .exe; `latest-mac.yml` se genera pero NO se publica a propósito:
 * solo serviría para que alguien active el autoUpdater en macOS y se coma el fallo de firma.
 */

const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");
const { isNewer } = require("./version");
const pkg = require("../package.json");

// electron se requiere DENTRO de las funciones que lo usan, no arriba: así el self-check del
// final corre con node pelado y sin node_modules, que es como lo ejecuta el CI (el job de
// versión no hace `npm ci` a propósito). Con el require arriba, MODULE_NOT_FOUND.
const electron = () => require("electron");

const REPO = (String(pkg.repository?.url || "").match(/github\.com[/:]([^/]+\/[^/.]+)/) || [])[1] || null;

// Hosts desde los que aceptamos bajar un ejecutable. El renderer NUNCA manda una URL (solo
// dispara la acción) y la resolvemos contra la API del propio repo, pero lo validamos igual:
// descargar y ABRIR un binario es el trust boundary más peligroso de la app, y una release
// puede llevar assets subidos a cualquier sitio.
const ALLOWED_HOSTS = [
  "github.com",
  "api.github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
];

function isAllowedDownload(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && ALLOWED_HOSTS.includes(u.hostname);
  } catch {
    return false;
  }
}

/**
 * El .dmg a bajar en macOS: primero el del arch actual, luego el universal (sin arch en el
 * nombre). Devuelve null antes que un binario de otro arch — un .dmg arm64 en un Mac Intel no
 * arranca, y es mejor abrir la página de la release que dar un fichero inútil.
 */
function pickMacAsset(assets, arch = process.arch) {
  const dmgs = (assets || []).filter((a) => a.name.endsWith(".dmg"));
  return dmgs.find((a) => a.name.includes(arch)) || dmgs.find((a) => !/arm64|x64|ia32/.test(a.name)) || null;
}

async function latestRelease() {
  if (!REPO) throw new Error("repositorio desconocido");
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { "User-Agent": "Monstro", Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}`);
  return res.json();
}

/** Solo informa: no descarga ni instala nada. Contrato estable, lo consume el toast de arranque. */
async function check() {
  const current = electron().app.getVersion();
  try {
    const json = await latestRelease();
    const latest = String(json.tag_name || "").replace(/^v/, "");
    if (!latest) return { current, error: "sin releases publicadas" };
    return { current, latest, url: json.html_url, newer: isNewer(latest, current) };
  } catch (err) {
    return { current, error: String(err.message || err) };
  }
}

async function download(url, dest, expectedSize, onProgress) {
  const res = await fetch(url, { headers: { "User-Agent": "Monstro" }, redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`descarga falló: HTTP ${res.status}`);
  // GitHub redirige los assets a githubusercontent: validamos el destino FINAL, no solo el inicial.
  if (!isAllowedDownload(res.url)) throw new Error(`redirección no permitida: ${res.url}`);

  // `asset.size` de la API primero y content-length como respaldo, NO al revés: si la respuesta
  // llega comprimida, fetch la descomprime y content-length mide los bytes COMPRIMIDOS — el
  // progreso se clavaría en el tope enseguida (comprobado: 1156 de header para 6968 reales).
  const total = expectedSize || Number(res.headers.get("content-length")) || 0;
  // Descargamos a .part y renombramos al final: si se corta la conexión no dejamos un .dmg
  // truncado en Descargas que el usuario intente abrir.
  const tmp = `${dest}.part`;
  let done = 0;
  let last = -1;
  try {
    const body = Readable.fromWeb(res.body);
    body.on("data", (chunk) => {
      done += chunk.length;
      if (!total) return;
      // Solo al cambiar el entero: un .dmg de ~115 MB son ~1800 chunks, y no vamos a mandar 1800
      // mensajes IPC + setProgressBar para pintar 100 valores distintos.
      const percent = Math.min(99, Math.round((done / total) * 100));
      if (percent === last) return;
      last = percent;
      onProgress(percent);
    });
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(tmp);
      body.pipe(out);
      out.on("finish", resolve);
      out.on("error", reject);
      body.on("error", reject);
    });
    fs.renameSync(tmp, dest);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

async function installMac(onProgress) {
  const { app, shell } = electron();
  const json = await latestRelease();
  const asset = pickMacAsset(json.assets);
  if (!asset) {
    await shell.openExternal(json.html_url);
    return { ok: true, mode: "browser" };
  }
  if (!isAllowedDownload(asset.browser_download_url)) {
    throw new Error(`origen de descarga no permitido: ${asset.browser_download_url}`);
  }
  const dest = path.join(app.getPath("downloads"), asset.name);
  await download(asset.browser_download_url, dest, asset.size, onProgress);
  onProgress(100);
  // openPath y no openExternal: es una ruta local, y el Finder monta el .dmg.
  const err = await shell.openPath(dest);
  if (err) throw new Error(err);
  // Y nos vamos: macOS no deja reemplazar una app EN EJECUCIÓN, así que con Monstro vivo el arrastre
  // a Aplicaciones falla ("no se puede sustituir porque está abierta") justo después de haberse
  // bajado 115 MB. El .dmg ya está montado por el Finder, que es otro proceso y sobrevive al quit.
  // El margen es para que el invoke conteste y el renderer pinte el aviso (igual que installWindows).
  setTimeout(() => app.quit(), 1200);
  return { ok: true, mode: "dmg", path: dest };
}

async function installWindows(onProgress) {
  // require aquí y no arriba: en macOS no se usa y no hay por qué cargarla al arrancar.
  const { autoUpdater } = require("electron-updater");
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.removeAllListeners("download-progress");
  autoUpdater.on("download-progress", (p) => onProgress(Math.min(99, Math.round(p.percent))));

  const found = await autoUpdater.checkForUpdates();
  if (!found?.updateInfo) return { ok: false, error: "sin actualización disponible" };
  await autoUpdater.downloadUpdate();
  onProgress(100);
  // Con margen para que el invoke conteste y el renderer pinte "reiniciando" antes de morir.
  setTimeout(() => autoUpdater.quitAndInstall(), 1200);
  return { ok: true, mode: "restart" };
}

/** @param onProgress recibe el % (0-100). Lanza si falla; el llamante decide qué contar. */
function install(onProgress = () => {}) {
  return process.platform === "win32" ? installWindows(onProgress) : installMac(onProgress);
}

module.exports = { check, install, pickMacAsset, isAllowedDownload };

// ponytail: self-check de lo único con lógica y sin electron detrás — elegir el asset correcto
// (bajar el de otro arch = app que no arranca) y el filtro de hosts (bajar+abrir un binario).
if (require.main === module) {
  const assert = require("assert");
  const A = (name) => ({ name, browser_download_url: `https://github.com/x/y/releases/download/v1/${name}` });

  const real = [A("Monstro-0.4.0-arm64.dmg"), A("Monstro-0.4.0-arm64-mac.zip"), A("Monstro.Setup.0.4.0.exe")];
  assert.strictEqual(pickMacAsset(real, "arm64").name, "Monstro-0.4.0-arm64.dmg");
  assert.strictEqual(pickMacAsset(real, "x64"), null, "nunca un dmg de otro arch");
  assert.strictEqual(pickMacAsset([A("Monstro-0.4.0.dmg")], "x64").name, "Monstro-0.4.0.dmg", "universal vale");
  assert.strictEqual(pickMacAsset([A("Monstro-0.4.0-x64.dmg")], "x64").name, "Monstro-0.4.0-x64.dmg");
  assert.strictEqual(pickMacAsset([], "arm64"), null);
  assert.strictEqual(pickMacAsset(undefined, "arm64"), null);
  assert.strictEqual(pickMacAsset([A("Monstro.Setup.0.4.0.exe")], "arm64"), null, "solo .dmg");

  assert.strictEqual(isAllowedDownload("https://github.com/a/b/releases/download/v1/x.dmg"), true);
  assert.strictEqual(isAllowedDownload("https://objects.githubusercontent.com/x"), true);
  assert.strictEqual(isAllowedDownload("http://github.com/a/b/x.dmg"), false, "https obligatorio");
  assert.strictEqual(isAllowedDownload("https://evil.com/x.dmg"), false);
  assert.strictEqual(isAllowedDownload("https://github.com.evil.com/x.dmg"), false, "sufijo, no host");
  assert.strictEqual(isAllowedDownload("no-es-una-url"), false);
  console.log("✓ updater ok");
}
