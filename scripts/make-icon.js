"use strict";

/**
 * Genera assets/icon-1024.png renderizando el SVG del monstruo (Monstro) con el
 * propio Electron (ventana offscreen transparente + capturePage). Después, el
 * empaquetado a .icns se hace con sips/iconutil (ver README / npm run icon).
 */
const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");

const SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#6573ef"/>
      <stop offset="1" stop-color="#7f3df0"/>
    </linearGradient>
    <linearGradient id="shine" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.22"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="body" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#5ff0b8"/>
      <stop offset="1" stop-color="#23c98c"/>
    </linearGradient>
  </defs>
  <rect x="64" y="64" width="896" height="896" rx="200" fill="url(#bg)"/>
  <rect x="64" y="64" width="896" height="448" rx="200" fill="url(#shine)"/>
  <!-- cuernos -->
  <path d="M 372 332 L 322 196 L 452 312 Z" fill="#2b2f55"/>
  <path d="M 652 332 L 702 196 L 572 312 Z" fill="#2b2f55"/>
  <!-- cuerpo -->
  <rect x="292" y="296" width="440" height="452" rx="158" fill="url(#body)"/>
  <!-- piececitos -->
  <ellipse cx="392" cy="748" rx="62" ry="40" fill="#23c98c"/>
  <ellipse cx="632" cy="748" rx="62" ry="40" fill="#23c98c"/>
  <!-- ojo (cíclope) -->
  <circle cx="512" cy="468" r="126" fill="#ffffff"/>
  <circle cx="512" cy="480" r="60" fill="#2b2f55"/>
  <circle cx="542" cy="452" r="22" fill="#ffffff"/>
  <!-- boca + colmillos -->
  <path d="M 416 606 Q 512 700 608 606 Z" fill="#2b2f55"/>
  <path d="M 466 612 L 502 612 L 484 660 Z" fill="#ffffff"/>
  <path d="M 540 612 L 576 612 L 558 654 Z" fill="#ffffff"/>
</svg>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    transparent: true,
    frame: false,
    webPreferences: { offscreen: true },
  });
  const html = `<!doctype html><html><body style="margin:0;background:transparent">${SVG}</body></html>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((resolve) => setTimeout(resolve, 600));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  const outDir = path.join(__dirname, "..", "assets");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "icon-1024.png"), image.toPNG());
  console.log("icon-1024.png generado");
  app.quit();
});
