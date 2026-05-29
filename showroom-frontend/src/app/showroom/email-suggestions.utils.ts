/**
 * Helpers compartidos para el autocomplete del email del cliente. Antes
 * estaban duplicados en showroom-page, presupuestos-page, cotizador-page y
 * crear-pedido-dialog — al ser exactamente la misma lógica, una divergencia
 * accidental (ej. agregar un dominio en un solo lugar) confundía al
 * operador al ver sugerencias diferentes según la pantalla.
 */

/** Dominios sugeridos al tipear el email. Orden = popularidad esperada en AR;
 *  los `.com.ar` van al final porque son menos usados pero existen. */
export const DOMINIOS_EMAIL_SUGERIDOS = [
  'gmail.com',
  'hotmail.com',
  'outlook.com',
  'yahoo.com.ar',
  'live.com',
  'icloud.com',
  'hotmail.com.ar',
  'outlook.com.ar',
  'live.com.ar',
];

/**
 * Calcula las sugerencias de email a partir de lo que tipeó el operador:
 * <ul>
 *   <li>Sin `@` todavía: sugerir <code>{query}@{dominio}</code> para cada
 *       dominio popular.</li>
 *   <li>Con `@` ya escrito: filtrar la lista por los dominios que matcheen
 *       lo que sigue al `@`.</li>
 *   <li>Si ya hay un dominio completo y NO matchea ninguno de los populares,
 *       no sugiere nada (no pisamos la elección manual del operador).</li>
 * </ul>
 */
export function calcularSugerenciasEmail(query: string | null | undefined): string[] {
  const q = (query ?? '').trim();
  if (!q) return [];
  const at = q.indexOf('@');
  if (at < 0) {
    return DOMINIOS_EMAIL_SUGERIDOS.map((d) => `${q}@${d}`);
  }
  const localPart = q.substring(0, at);
  const dominioPart = q.substring(at + 1).toLowerCase();
  if (!localPart) return [];
  // Ya hay un dominio "completo" (algo.algo) que no matchea ningún sugerido →
  // el operador está tipeando algo custom, no le pisamos con sugerencias.
  if (dominioPart.includes('.')
      && !DOMINIOS_EMAIL_SUGERIDOS.some((d) => d.startsWith(dominioPart))) {
    return [];
  }
  return DOMINIOS_EMAIL_SUGERIDOS
    .filter((d) => d.startsWith(dominioPart))
    .map((d) => `${localPart}@${d}`);
}
