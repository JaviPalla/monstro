// renderLocal(): decide qué pantalla de Trabajo local se pinta según el estado.
// Parte de la vista de Trabajo local — el dispatcher es renderLocal() en local.js.
function renderLocal() {
  if (state.view !== "local") return;
  const l = state.local;
  if (l.loading) {
    list.innerHTML = `<div class="loading">${t("Escaneando repos locales…")}</div>`;
    return;
  }
  if (l.form) return renderLocalForm();
  if (l.linkForm) return renderLocalLinkForm();
  if (l.tab === "historico") return renderLocalHistory();
  if (l.tab === "empezar") return l.runView ? renderLocalRun() : l.planForm ? renderLocalPlanForm() : renderLocalStart();
  const isCrear = l.tab === "crear";
  const desc = isCrear
    ? t("Elige repo y rama/worktree de tu local para crear una <b>Issue/Epic</b> nueva y su <b>MR</b>.")
    : t("Elige repo y rama/worktree de tu local para <b>vincular</b> el trabajo a una Issue/Epic existente y lanzar la <b>MR</b>.");
  const head = `
    <div class="local-head">
      <h2>${isCrear ? t("Crear tarea") : t("Vincular tarea")}</h2>
      <p class="local-desc">${desc}</p>
    </div>`;

  if (!l.rootDir) {
    list.innerHTML =
      head +
      `<div class="local-empty">
        <p>${t("Aún no has indicado el <b>directorio raíz</b> donde tienes clonados tus repos de GitLab.")}</p>
        <button class="btn btn-primary" id="local-pick">${t("Elegir directorio raíz…")}</button>
      </div>`;
    $("#local-pick")?.addEventListener("click", pickLocalRoot);
    notifySelftestOnce();
    return;
  }

  const repos = l.repos || [];
  // Las carpetas se AGRUPAN por su repo base de GitLab (mismo remote origin): varios worktrees/clones
  // del mismo proyecto quedan bajo una cabecera estilo chip de proyecto (icono + nombre). Las carpetas
  // sin remote de GitLab van a un grupo aparte. Seleccionar es por carpeta; 1 marcada = tarea, 2+ = Epic.
  const folderCard = (r) => {
    const info = l.info[r.dir] || {};
    const meta = info.error
      ? `<span class="local-err">${esc(info.error)}</span>`
      : `<span class="local-cur">⎇ ${esc(info.current || "—")}</span>
         ${info.dirty ? `<span class="local-dirty" title="${esc(t("Cambios sin commitear"))}">${t("● sucio")}</span>` : ""}
         <span class="local-count">${t("{n} ramas · {m} worktrees", { n: (info.branches || []).length, m: (info.worktrees || []).length })}</span>`;
    const selectable = Boolean(r.gitlabPath);
    const checked = l.selected.has(r.dir);
    return `
      <div class="local-repo ${selectable ? "selectable" : ""} ${checked ? "checked" : ""}" ${selectable ? `data-dir="${esc(r.dir)}"` : ""}>
        <div class="local-repo-top">
          ${selectable ? `<input type="checkbox" class="local-cb" ${checked ? "checked" : ""} />` : ""}
          <span class="local-name">${esc(r.name)}</span>
        </div>
        <div class="local-repo-meta">${meta}</div>
      </div>`;
  };
  const groups = new Map();
  for (const r of repos) {
    const key = r.gitlabPath || "__none__";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const cards = [...groups.entries()]
    .sort((a, b) => (a[0] === "__none__" ? 1 : b[0] === "__none__" ? -1 : projectMeta(a[0]).name.localeCompare(projectMeta(b[0]).name)))
    .map(([key, folders]) => {
      const known = folders[0].known;
      const groupHead =
        key === "__none__"
          ? `<div class="local-group-head"><span class="local-badge none">${t("Sin remote de GitLab")}</span><span class="local-group-count">${folders.length === 1 ? t("{n} carpeta", { n: folders.length }) : t("{n} carpetas", { n: folders.length })}</span></div>`
          : `<div class="local-group-head">
              ${projectIconHtml(key)}
              <span class="ms-proj-name">${esc(projectMeta(key).name)}</span>
              <span class="local-group-path" title="${esc(key)}">${esc(key)}</span>
              ${known ? `<span class="local-badge ok" title="${esc(t("Proyecto configurado en Monstro"))}">✓</span>` : ""}
              ${folders.length > 1 ? `<span class="local-group-count">${t("{n} carpetas", { n: folders.length })}</span>` : ""}
            </div>`;
      return `<div class="local-group">${groupHead}<div class="local-group-folders">${folders.map(folderCard).join("")}</div></div>`;
    })
    .join("");

  const selCount = l.selected.size;
  const btnLabel = isCrear ? (selCount > 1 ? t("Crear épica →") : t("Crear tarea →")) : t("Vincular →");
  const selNote = isCrear && selCount > 1 ? t(" · se creará una Epic") : "";
  const actionBar = repos.some((r) => r.gitlabPath)
    ? `<div class="local-actionbar">
        <span class="local-selcount">${selCount === 1 ? t("{n} seleccionado", { n: selCount }) : t("{n} seleccionados", { n: selCount })}${selNote}</span>
        <button class="btn btn-primary" id="local-continue" ${selCount ? "" : "disabled"}>${btnLabel}</button>
      </div>`
    : "";

  list.innerHTML =
    head +
    `<div class="local-root">
      <span class="local-root-path" title="${esc(l.rootDir)}">📁 ${esc(l.rootDir)}</span>
      <button class="btn local-change" id="local-pick">${t("Cambiar…")}</button>
    </div>
    ${repos.length ? `<div class="local-repos">${cards}</div>` : `<div class="local-empty"><p>${t("No se han encontrado repos git directamente bajo ese directorio.")}</p></div>`}
    ${repos.length ? `<p class="local-legend"><span class="local-dirty">${t("● sucio")}</span> ${t("= el repo tiene cambios sin commitear; se commitearán (con tu mensaje + el #ID de la issue) al crear la tarea.")}</p>` : ""}
    ${actionBar}`;
  $("#local-pick")?.addEventListener("click", pickLocalRoot);
  list.querySelectorAll(".local-repo.selectable").forEach((el) =>
    el.addEventListener("click", () => {
      const dir = el.dataset.dir;
      if (l.selected.has(dir)) l.selected.delete(dir);
      else l.selected.add(dir);
      renderLocal();
    }),
  );
  $("#local-continue")?.addEventListener("click", () => (isCrear ? openLocalForm([...l.selected]) : openLocalLinkForm([...l.selected])));
  notifySelftestOnce();
}

// Abre el formulario para los repos `dirs` (1 = tarea single; 2+ = Epic). Siembra rama origen/destino.
// Milestone activo "actual" por fechas (start_date ≤ hoy ≤ due_date); si ninguno encaja, null.
