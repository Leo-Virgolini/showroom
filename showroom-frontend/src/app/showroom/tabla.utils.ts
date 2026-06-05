import { TableLazyLoadEvent } from 'primeng/table';
import { WritableSignal } from '@angular/core';

/** Extrae sortField/sortOrder de un TableLazyLoadEvent (p-table: 1=asc, -1=desc).
 *  Devuelve los defaults si el evento no trae sort. */
export function sortDesdeLazyLoad(
  event: TableLazyLoadEvent,
  defaultField: string,
  defaultOrder: 'asc' | 'desc',
): { sortField: string; sortOrder: 'asc' | 'desc' } {
  let sortField = defaultField;
  let sortOrder = defaultOrder;
  if (typeof event.sortField === 'string' && event.sortField) sortField = event.sortField;
  if (event.sortOrder === 1 || event.sortOrder === -1) sortOrder = event.sortOrder === 1 ? 'asc' : 'desc';
  return { sortField, sortOrder };
}

/** Fin del día (23:59:59.999) de una fecha — para filtros "hasta" inclusivos. */
export function finDelDia(d: Date): Date {
  const end = new Date(d);
  end.setHours(23, 59, 59, 999);
  return end;
}

/** Agrega/saca un id de un signal Set<T> (para flags de "cargando/enviando" por fila). */
export function marcarEnSet<T>(sig: WritableSignal<Set<T>>, item: T, on: boolean): void {
  const next = new Set(sig());
  if (on) next.add(item); else next.delete(item);
  sig.set(next);
}
