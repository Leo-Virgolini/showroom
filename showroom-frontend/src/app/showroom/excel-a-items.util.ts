/**
 * Parseo de un Excel/CSV de cliente con dos columnas (SKU y cantidad) a las
 * filas que alimentan el detalle del presupuesto.
 *
 * <p>Vive fuera del componente y sin dependencias de Angular para poder testear
 * el parseo — la parte con reglas de negocio reales — sin montar la UI ni
 * mockear HTTP. El componente solo lee el archivo y llama a estas funciones.
 */

import type { CatalogoItem, PresupuestoItem } from './models';

/** Una línea del archivo ya normalizada. */
export interface FilaImportada {
  sku: string;
  cantidad: number;
}

/** Palabras clave que identifican la columna de SKU en el encabezado. */
const RE_COL_SKU = /(sku|c[oó]d|art[ií]c)/i;
/** Palabras clave que identifican la columna de cantidad en el encabezado. */
const RE_COL_CANTIDAD = /(cant|qty|unid)/i;

/** Celda → string limpio. Excel devuelve números para los SKU numéricos. */
function texto(celda: unknown): string {
  if (celda === null || celda === undefined) return '';
  return String(celda).trim();
}

/**
 * Celda → cantidad entera positiva. Cualquier valor ausente, no numérico,
 * o que trunce a < 1 cae en 1: el operador puede corregirlo después en la
 * tabla, y perder la línea entera por una celda mal tipeada sería peor.
 */
function cantidad(celda: unknown): number {
  const n = Number(texto(celda).replace(',', '.'));
  if (!Number.isFinite(n)) return 1;
  const truncated = Math.floor(n);
  if (truncated < 1) return 1;
  return truncated;
}

/**
 * Convierte las filas crudas del archivo en `{sku, cantidad}[]`.
 *
 * <p>Detecta el encabezado en la primera fila por palabras clave; si detecta
 * las dos columnas usa sus posiciones (soporta el orden invertido). Si detecta
 * solo una, saltea igual la primera fila pero cae a las posiciones por
 * defecto. Si no detecta ninguna, asume que no hay encabezado y usa columna
 * A = SKU, columna B = cantidad.
 *
 * <p>Consolida los SKU repetidos sumando cantidades: dos filas del mismo
 * producto son un pedido de la suma, no dos líneas separadas.
 */
export function parsearFilasImportadas(filas: unknown[][]): FilaImportada[] {
  if (filas.length === 0) return [];

  const cabecera = (filas[0] ?? []).map(texto);
  const idxSku = cabecera.findIndex((c) => RE_COL_SKU.test(c));
  const idxCantidad = cabecera.findIndex((c) => RE_COL_CANTIDAD.test(c));

  let colSku = 0;
  let colCantidad = 1;
  let inicio = 0;
  if (idxSku >= 0 && idxCantidad >= 0) {
    colSku = idxSku;
    colCantidad = idxCantidad;
    inicio = 1;
  } else if (idxSku >= 0 || idxCantidad >= 0) {
    inicio = 1;
  }

  // Map en vez de array para consolidar repetidos conservando el orden de
  // primera aparición (Map preserva el orden de inserción).
  const acumulado = new Map<string, number>();
  for (let i = inicio; i < filas.length; i++) {
    const fila = filas[i] ?? [];
    const sku = texto(fila[colSku]);
    if (!sku) continue;
    acumulado.set(sku, (acumulado.get(sku) ?? 0) + cantidad(fila[colCantidad]));
  }

  return [...acumulado].map(([sku, cant]) => ({ sku, cantidad: cant }));
}

/** Resultado de aplicar un import sobre el detalle actual. */
export interface ResultadoImport {
  /** Nuevo array de ítems del detalle (el original no se muta). */
  items: PresupuestoItem[];
  /** Cuántas líneas nuevas se crearon. */
  agregados: number;
  /** Cuántas líneas existentes recibieron más cantidad. */
  actualizados: number;
  /** SKU del archivo que no existen en el catálogo cacheado. */
  noEncontrados: string[];
}

/**
 * Aplica las filas importadas sobre el detalle actual con el mismo criterio
 * que el scan: si el SKU ya está, suma la cantidad conservando el uid y el
 * descuento de la línea; si no está, crea una línea nueva.
 *
 * <p>`nuevoUid` entra por parámetro para que la función quede pura y los tests
 * puedan predecir los uid generados.
 *
 * <p>Los ítems nuevos salen de `CatalogoItem`, que no trae `sincronizadoAt`
 * (el campo es nullable) — igual que los agregados desde la lista de
 * resultados de búsqueda.
 */
export function mergearImportados(
  actuales: PresupuestoItem[],
  filas: FilaImportada[],
  encontrados: CatalogoItem[],
  nuevoUid: (sku: string) => string,
): ResultadoImport {
  const porSku = new Map(encontrados.map((it) => [it.sku, it]));
  const items = [...actuales];
  const noEncontrados: string[] = [];
  let agregados = 0;
  let actualizados = 0;

  for (const fila of filas) {
    const item = porSku.get(fila.sku);
    if (!item) {
      noEncontrados.push(fila.sku);
      continue;
    }

    const idx = items.findIndex((it) => it.sku === fila.sku);
    if (idx >= 0) {
      items[idx] = { ...items[idx], cantidad: items[idx].cantidad + fila.cantidad };
      actualizados++;
      continue;
    }

    items.push({
      ...item,
      sincronizadoAt: null,
      uid: nuevoUid(fila.sku),
      cantidad: fila.cantidad,
      descuentoPorcentaje: 0,
    });
    agregados++;
  }

  return { items, agregados, actualizados, noEncontrados };
}
