/**
 * Decide a qué ítem del detalle llevar la vista (scroll + destello) cuando la
 * lista cambia, comparando un snapshot previo de cantidades por uid contra el
 * estado actual.
 *
 * <p>Vive fuera del componente y sin dependencias de Angular para poder testear
 * la regla — que es lo que tiene lógica real — sin montar la UI.
 *
 * <p>La regla apunta a UN solo ítem: solo tiene sentido scrollear cuando el
 * operador agrega/re-agrega un producto puntual desde el buscador. Si cambian
 * varios a la vez (importar un Excel, cargar un presupuesto guardado) no se
 * scrollea a ninguno — esos flujos tienen su propio feedback (toast de resumen).
 * Un borrado tampoco mueve la vista.
 */

import type { PresupuestoItem } from './models';

/** Snapshot `uid → cantidad` del detalle, para comparar contra el próximo estado. */
export function mapCantidades(items: readonly PresupuestoItem[]): Map<string, number> {
  return new Map(items.map((it) => [it.uid, it.cantidad]));
}

/**
 * Devuelve el uid a resaltar, o `null` si no hay que mover la vista.
 *
 * <p>Es candidato un uid que aparece nuevo (alta) o cuya cantidad AUMENTÓ
 * respecto del snapshot previo (re-agregar suma cantidad). Devuelve el uid
 * solo si hay EXACTAMENTE un candidato; con cero (borrado, sin cambios) o con
 * varios (import, carga masiva) devuelve `null`.
 */
export function uidADestacar(
  previo: ReadonlyMap<string, number>,
  actual: readonly PresupuestoItem[],
): string | null {
  const candidatos: string[] = [];
  for (const it of actual) {
    const antes = previo.get(it.uid);
    if (antes === undefined || it.cantidad > antes) {
      candidatos.push(it.uid);
      if (candidatos.length > 1) return null;
    }
  }
  return candidatos.length === 1 ? candidatos[0] : null;
}
