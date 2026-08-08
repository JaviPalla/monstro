# Self-update

Read this when touching `src/updater.js`, `update:*` IPC, the boot toast, or the release
pipeline (`.github/workflows/release.yml`, `build.publish` in package.json).

**Self-update** (`src/updater.js`, toast at boot in `boot.js` → `startUpdate`): checks the app's own **public** GitHub releases (no token, independent of `config.provider`); `config.checkUpdates` gates it, selftest never fires it.

**Hybrid by platform, and NOT by choice**: on **Windows** it's a real update via electron-updater (NSIS); on **macOS** it downloads the `.dmg`, opens it and then **quits the app** — macOS refuses to replace a *running* app, so leaving Monstro alive makes the drag to Applications fail right after a 115 MB download. The Finder is a separate process and keeps the mounted `.dmg` after the quit; the 1200 ms delay is the same margin `installWindows` uses so the invoke can answer and the renderer paint the toast before the process dies.

**Why macOS can't update in place: Squirrel.Mac validates the downloaded zip's code signature and demands the same valid identity as the installed app, but Monstro is signed ad-hoc (`scripts/adhoc-sign.js`, no Team ID) → "Code signature did not pass validation".** Fixing that needs a Developer ID cert + notarization (paid Apple account); until then do not enable `autoUpdater` on macOS.

**Pipeline gotcha: electron-updater does NOT read the GitHub API** — it reads `latest.yml`, which electron-builder only writes when `build.publish` exists in package.json (that key is there for the metadata, *not* to publish — the CI still builds with `--publish never` and releases via softprops). `release.yml` uploads `dist/latest.yml` alongside the `.exe`; **`latest-mac.yml` is generated but deliberately never published** (verified: both are written even with `--publish never`).

The renderer only fires `update:install` with **no arguments** — it never passes a URL: `updater.js` resolves the asset from the API and validates the final redirect host against `ALLOWED_HOSTS` (download+open of a binary is the app's most dangerous trust boundary). `pickMacAsset` returns **null rather than a different arch's dmg** (an arm64 dmg won't launch on Intel) and then falls back to opening the release page. Download goes to `.part` + rename (no truncated dmg in Downloads), progress uses `asset.size` and **not** content-length (compressed responses make that header lie) and only emits on integer change (~1800 chunks otherwise). Progress shows in the native Dock/taskbar bar (`win.setProgressBar`) plus a sticky toast.

**Release description**: the body is written by `scripts/release-notes.js` from the conventional commits between the previous tag and this one, grouped as ⚠️ Cambios importantes / ✨ Novedades / 🐛 Arreglos y mejoras. Same filter as `next-version.js` — only what changes what the user installs (feat/fix/perf/breaking); merges and chore/docs/ci/refactor/test never reach the release page. Three things that are the way they are on purpose:
- It runs in `release.yml`'s `release` job (which now needs `checkout` with `fetch-depth: 0`), **not** in `auto-release.yml` passed as an input — that way the description comes out the same whether the release came from auto-release, a tag push or a manual dispatch.
- The previous tag is `git describe … "$TAG^"`, not plain `git describe`: republishing an old tag would otherwise resolve to itself and the range would come out empty.
- softprops gets **`body_path`, never `body`** — the markdown carries newlines and quotes, and interpolating it through `${{ }}` breaks the YAML the first time a commit subject has an odd character. `generate_release_notes: true` stays on: GitHub appends its "Full Changelog" and PR list below our summary.

The quality of the release page is the quality of the commit subjects — this only groups and cleans them up. A subject packing several conventional commits into one line is split into one entry each (there is a real one in the history, `509de8b`).

Checks: `node src/updater.js`, `node scripts/test-release-notes.js`.
