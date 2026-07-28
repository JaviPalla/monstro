"use strict";

// Handlers IPC de la bandeja de propuestas: sesión de Outlook, listado de correos, propuesta de la
// IA y creación de la Epic con sus tareas hijas. Se registran desde wireIpc() en src/main.js.
//
// El correo NUNCA crea nada por su cuenta: `mail:propose` devuelve un borrador y solo `mail:create`,
// que dispara un click explícito del usuario, escribe en GitLab.

const { ipcMain } = require("electron");
const ai = require("../ai");
const mail = require("../mail");
const provider = require("../provider");

const gh = () => provider.current();

function register() {
  ipcMain.handle("mail:status", () => mail.status());
  ipcMain.handle("mail:startLogin", () => mail.startLogin());
  ipcMain.handle("mail:pollLogin", (_event, { deviceCode }) => mail.pollLogin(deviceCode));
  ipcMain.handle("mail:logout", () => {
    mail.logout();
    return mail.status();
  });
  ipcMain.handle("mail:list", () => mail.listProposals({}));

  // Correo → borrador de Epic. Los proyectos elegibles salen del grupo configurado, así el modelo
  // solo puede repartir tareas entre paths que existen de verdad.
  ipcMain.handle("mail:propose", async (_event, { email }) => {
    const projects = await gh().groupProjects();
    const paths = projects.filter((p) => !p.archived).map((p) => p.path);
    return ai.proposeFromEmail({ email, projectPaths: paths });
  });

  // Crea la Epic y sus tareas hijas. Secuencial y NO atómico, como el resto de mutaciones batch de
  // GitLab: si la Epic falla no se sigue, y cada tarea se reporta por separado.
  ipcMain.handle("mail:create", async (_event, { epicTitle, epicDescription, tasks, labels, milestoneId, messageId }) => {
    const projRe = /^[\w.-]+(\/[\w.-]+)*$/;
    const list = Array.isArray(tasks) ? tasks : [];
    if (!epicTitle || !String(epicTitle).trim()) throw new Error("El título de la Epic es obligatorio");
    if (!list.length) throw new Error("La Epic necesita al menos una tarea");
    const safeLabels = (Array.isArray(labels) ? labels : []).filter((l) => typeof l === "string" && l.trim());
    const me = await gh().viewer().catch(() => null);
    const assigneeIds = me?.id ? [me.id] : undefined;
    const mid = Number.isInteger(milestoneId) ? milestoneId : null;

    const epic = await gh().createEpic({ title: String(epicTitle).trim(), description: epicDescription || "", labels: safeLabels, milestoneId: mid, assigneeIds });
    const epicRef = `${epic.projectPath}#${epic.iid}`;
    const results = [];
    for (const task of list) {
      try {
        if (!projRe.test(task.projectPath || "")) throw new Error("Proyecto no válido");
        if (!task.title || !String(task.title).trim()) throw new Error("Falta el título de la tarea");
        const checkItems = (Array.isArray(task.checklist) ? task.checklist : []).filter((c) => typeof c === "string" && c.trim());
        const checklistMd = checkItems.length ? `\n\n## Puntos a comprobar\n${checkItems.map((c) => `- [ ] ${c.trim()}`).join("\n")}` : "";
        const issue = await gh().createIssue(task.projectPath, {
          title: String(task.title).trim(),
          description: `Épica: ${epicRef}\n\n${task.description || ""}${checklistMd}`,
          labels: safeLabels,
          milestoneId: mid,
          assigneeIds,
        });
        // Best-effort: que falle el enlace no debe invalidar una issue ya creada.
        let linked = true;
        try {
          await gh().createIssueLink(epic.projectPath, epic.iid, issue.projectId, issue.iid);
        } catch {
          linked = false;
        }
        results.push({ projectPath: task.projectPath, ok: true, issue, linked });
      } catch (err) {
        results.push({ projectPath: task.projectPath, ok: false, error: String(err.message || err) });
      }
    }
    // Marcar el correo como leído es lo último: si algo revienta antes, sigue apareciendo pendiente.
    if (messageId && results.some((r) => r.ok)) await mail.markProcessed(messageId).catch(() => {});
    return { epic, results };
  });
}

module.exports = { register };
