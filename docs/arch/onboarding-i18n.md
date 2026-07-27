# Onboarding, menu sections & i18n

Read this when touching `boot.js`, `renderWelcome`, `renderSectionPicker`, `MENU_SECTIONS` in
`core.js`, or `renderer/app/i18n.js`.

## Onboarding (guided)

4 steps, driven by `boot()` state gates — provider → token → repos → **sections**.

The **token step** (`renderWelcome`) is guided, not manual: a "Crear token en {provider} ↗" button opens the exact PAT-creation page with name+scopes prefilled (GitLab `…/-/user_settings/personal_access_tokens?name=Monstro&scopes=api,read_user`; GitHub `…/settings/tokens/new?…`) + a paste field that saves via `setConfig({token})` and validates with `authStatus()`; CLI/env stay as a collapsed `<details>` fallback.

The **sections step** (`renderSectionPicker`) asks which menu sections to include (role presets Desarrollo/Operaciones/Todo pre-check the toggles, then fine-tune).

Selftest routes: `--selftest-route=onboarding-token` / `onboarding-sections`.

## Menu sections (`config.sections`)

Which sidebar sections are visible. **Single source of truth = `MENU_SECTIONS` in `core.js`** (key → label/icon/`navId`/bucket selectors/`gitlabOnly`); `applyMenuVisibility()` (called in `boot()`) hides each section's nav header + buckets when it's GitLab-only-on-GitHub OR not in `config.sections`.

`sectionEnabled(key)` is the gate (null/undefined sections = all enabled, retrocompat). The command palette, digit/letter shortcuts and the boot landing (`firstAvailableLanding`, for profiles without PRs) all route through `sectionEnabled`. Editable later in Settings ("Apartados del menú", min 1).

**Adding a new sidebar section = add one entry to `MENU_SECTIONS`** (and its `navId` to `index.html`).

## i18n (ES/EN, OPE-24)

`renderer/app/i18n.js` is a **"Spanish-string-as-key"** table. Wrap user-visible text in `t("texto español", { param })`; the Spanish string IS the key, `I18N_EN` maps it to English, interpolation uses `{name}` placeholders.

**In Spanish `t(x) === x`** (no-op), so new UI defaults to Spanish for free and ES rendering can never break from wrapping — only add the EN entry to `I18N_EN`.

**Never wrap** enum literals, GitLab label names, config keys, CSS/ids, API params, or anything compared/used-as-key (it would break English mode).

Static `index.html` chrome uses `data-i18n`/`data-i18n-title`/`data-i18n-placeholder` + `localizeStatic()` (runs on boot, only in EN).

Language resolves in `boot()` via `applyLang(config)`: `config.language` (`es`/`en`/null) else system locale (`config.systemLocale` from `app.getLocale()`, `es-*` → es else en); the Settings selector persists it and **reloads the window** (`setLanguage`). `config:set` whitelists `language`. Selftest/preview override: `--lang=en` (URL `?lang=` param, highest priority).
