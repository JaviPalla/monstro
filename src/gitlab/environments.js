"use strict";

// vista de Entornos: entornos de un proyecto con su último despliegue, ordenados por tier.
// Parte de la implementación del proveedor GitLab — ver src/gitlab.js para la interfaz pública.

const { api, proj } = require("./core");

const TIER_RANK = { development: 0, testing: 1, staging: 2, production: 3, other: 4 };

/**
 * Entornos de un proyecto con su ÚLTIMO despliegue (vista de Entornos).
 *
 * GOTCHA verificado contra la instancia: `GET /environments` NO devuelve `last_deployment` (solo el
 * detalle por entorno lo trae). En vez de N llamadas al detalle, una a `/deployments?environment=`
 * por entorno.
 *
 * GOTCHA 2 (lo que motivó este cambio): pedir el "último despliegue" a secas MIENTE. Un entorno
 * acumula por encima del último deploy real un montón de `blocked` (jobs `when: manual` que nadie ha
 * lanzado), `created`/`canceled` (pushes de ramas sueltas que disparan el pipeline) y `skipped`.
 * Ninguno de esos desplegó NADA: production salía con `rb/072026` (un job manual sin lanzar) cuando
 * lo que corre de verdad es el tag `2026.06.2`. La ÚNICA señal fiable de "qué versión hay ahí" es el
 * último despliegue con `status=success`, así que filtramos por eso EN LA API (no en cliente: el
 * success real puede estar decenas de deployments más abajo). Si no hay ninguno → "Sin despliegues".
 *
 * Coste: 1 + M llamadas por proyecto (M = entornos), las M en paralelo. Pensado para refresco bajo
 * demanda, NO para el poll. NO lanza por entorno: un fallo deja ese entorno sin deploy, no tumba la fila.
 */

async function projectEnvironments(projectId) {
  const id = proj(String(projectId));
  const envs = await api("GET", `/projects/${id}/environments?states=available&per_page=100`);
  const out = await Promise.all(
    (envs || []).map(async (e) => {
      let deployment = null;
      try {
        const ds = await api(
          "GET",
          `/projects/${id}/deployments?environment=${encodeURIComponent(e.name)}&status=success&order_by=created_at&sort=desc&per_page=1`,
        );
        const d = (ds || [])[0];
        if (d) {
          deployment = {
            status: d.status, // siempre "success" (lo filtra la query); lo dejamos por claridad
            ref: d.ref || null,
            sha: d.sha ? String(d.sha).slice(0, 8) : null,
            createdAt: d.created_at || null,
            user: d.user?.name || null,
            pipelineUrl: d.deployable?.pipeline?.web_url || null,
          };
        }
      } catch {
        deployment = null;
      }
      return {
        name: e.name,
        tier: e.tier || "other",
        state: e.state,
        externalUrl: e.external_url || null,
        webUrl: e.project?.web_url ? `${e.project.web_url}/-/environments/${e.id}` : null,
        deployment,
      };
    }),
  );
  return out.sort((a, b) => (TIER_RANK[a.tier] ?? 9) - (TIER_RANK[b.tier] ?? 9) || a.name.localeCompare(b.name));
}

/**
 * Pipelines de despliegue de un proyecto, ancladas a sus releases (OPE-25). Devuelve la lista de
 * releases recientes (para el selector "ver anteriores") y, para el `ref`/tag pedido (o la última
 * release si no se pasa), su pipeline + jobs. Los jobs `manual` son lanzables; cada job lleva su
 * web_url para abrir el log en GitLab. NO atómico por proyecto: el renderer llama uno por proyecto.
 * Solo GitLab.
 */

module.exports = {
  TIER_RANK,
  projectEnvironments,
};
