# Self-update

Read this when touching `src/updater.js`, `update:*` IPC, the boot toast, or the release
pipeline (`.github/workflows/release.yml`, `build.publish` in package.json).

**Self-update** (`src/updater.js`, toast at boot in `boot.js` → `startUpdate`): checks the app's own **public** GitHub releases (no token, independent of `config.provider`); `config.checkUpdates` gates it, selftest never fires it.

**Hybrid by platform, and NOT by choice**: on **Windows** it's a real update via electron-updater (NSIS); on **macOS** it downloads the `.dmg` and opens it (user drags to Applications).

**Why macOS can't update in place: Squirrel.Mac validates the downloaded zip's code signature and demands the same valid identity as the installed app, but Monstro is signed ad-hoc (`scripts/adhoc-sign.js`, no Team ID) → "Code signature did not pass validation".** Fixing that needs a Developer ID cert + notarization (paid Apple account); until then do not enable `autoUpdater` on macOS.

**Pipeline gotcha: electron-updater does NOT read the GitHub API** — it reads `latest.yml`, which electron-builder only writes when `build.publish` exists in package.json (that key is there for the metadata, *not* to publish — the CI still builds with `--publish never` and releases via softprops). `release.yml` uploads `dist/latest.yml` alongside the `.exe`; **`latest-mac.yml` is generated but deliberately never published** (verified: both are written even with `--publish never`).

The renderer only fires `update:install` with **no arguments** — it never passes a URL: `updater.js` resolves the asset from the API and validates the final redirect host against `ALLOWED_HOSTS` (download+open of a binary is the app's most dangerous trust boundary). `pickMacAsset` returns **null rather than a different arch's dmg** (an arm64 dmg won't launch on Intel) and then falls back to opening the release page. Download goes to `.part` + rename (no truncated dmg in Downloads), progress uses `asset.size` and **not** content-length (compressed responses make that header lie) and only emits on integer change (~1800 chunks otherwise). Progress shows in the native Dock/taskbar bar (`win.setProgressBar`) plus a sticky toast.

Check: `node src/updater.js`.
