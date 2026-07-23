"use strict";

/**
 * Veredicto de la sonda de salud de un entorno, como función pura para poder probarlo sin red
 * (scripts/test-health-verdict.js).
 *
 * Son TRES estados a propósito. La tentación es "2xx = sano", y es falso: una SPA sirve su
 * index.html con 200 en CUALQUIER ruta, incluida una que no existe (verificado contra
 * dashboard.opensalud.es: /health, /status y /esto-no-existe devuelven los tres 200 text/html).
 * Un 200 con HTML solo demuestra que el servidor web está en pie, no que la aplicación funcione.
 * Por eso ese caso es `unknown` (ámbar) y no `up`: un health check que miente es peor que no tener
 * ninguno, porque te hace ignorar la alarma real.
 *
 * `up` requiere una prueba positiva: una respuesta que no sea HTML (una API devolviendo JSON), o
 * que el cuerpo contenga el texto esperado que se haya configurado.
 */
function healthVerdict({ ok, httpStatus, contentType = "", expect = "", bodyMatched = null }) {
  if (!ok) return { status: "down", note: `HTTP ${httpStatus}` };
  if (expect) {
    return bodyMatched ? { status: "up", note: "" } : { status: "down", note: "No aparece el texto esperado" };
  }
  if (/text\/html/i.test(contentType)) {
    return { status: "unknown", note: "Responde HTML: puede ser el index.html de la SPA. Configura una ruta de sonda." };
  }
  return { status: "up", note: "" };
}

module.exports = { healthVerdict };
