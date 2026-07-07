import { PedidoItemDetalle, PresupuestoItem } from './models';

/**
 * Hidrata los ítems de un pedido (`PedidoItemDetalle`) como `PresupuestoItem`
 * para el `carrito-editor`. Congela el precio del pedido usando
 * `precioListaConIva` — el PVP de lista PRE-forma (correcto para editar sin
 * duplicar el recargo/descuento de la forma de pago). Los pedidos anteriores
 * a esta columna no lo tienen (null): se cae a `precioUnitario` como
 * aproximación (ese valor es POST-forma, así que la pantalla de edición
 * re-cotiza esos ítems a la lista vigente por separado). Se sigue respetando
 * `aplicaIva === false` (perfil sin IVA, p.ej. maquinaria), donde el valor
 * persistido YA es sin IVA y se reconstruye el con-IVA multiplicando por el
 * factor de `porcIva`. Los campos de catálogo que el pedido no guarda
 * (`stockTotal`, `habilitado`, `sincronizadoAt`) se defaultean; el `uid` es
 * único por índice+sku.
 */
export function pedidoItemsAPresupuestoItems(
  items: PedidoItemDetalle[],
  skuGenerico?: string | null,
): PresupuestoItem[] {
  return items.map((it, i) => {
    const porcIva = it.porcIva;
    const factor = porcIva != null && porcIva > 0 ? 1 + porcIva / 100 : 1;
    // `precioListaConIva` es el PVP de lista pre-forma (correcto para editar). Los
    // pedidos viejos no lo tienen (null) → fallback aproximado a precioUnitario
    // (la pantalla re-cotiza esos ítems a lista actual). Se sigue respetando
    // aplicaIva===false (perfil sin IVA: el valor persistido ya es sin IVA).
    const baseLista = it.precioListaConIva ?? it.precioUnitario ?? 0;
    const conIva = it.aplicaIva === false ? baseLista * factor : baseLista;
    const sinIva = it.aplicaIva === false ? baseLista : baseLista / factor;
    return {
      sku: it.sku,
      descripcion: it.descripcion,
      rubro: it.rubro ?? null,
      pvpKtGastroConIva: conIva,
      pvpKtGastroSinIva: sinIva,
      porcIva: porcIva,
      stockTotal: null,
      habilitado: true,
      imagenUrl: it.imagenUrl,
      sincronizadoAt: null,
      uid: `${it.sku}-${i}`,
      cantidad: it.cantidad,
      descuentoPorcentaje: it.descuentoPorcentaje ?? 0,
      generico: skuGenerico != null && it.sku === skuGenerico,
      comentarios: it.comentarios ?? null,
    };
  });
}
