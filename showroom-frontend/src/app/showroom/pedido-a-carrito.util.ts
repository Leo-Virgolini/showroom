import { PedidoItemDetalle, PresupuestoItem } from './models';

/**
 * Hidrata los ítems de un pedido (`PedidoItemDetalle`) como `PresupuestoItem`
 * para el `carrito-editor`. Congela el precio del pedido: `precioUnitario` es
 * CON IVA salvo cuando `aplicaIva === false` (perfil sin IVA, p.ej. maquinaria),
 * donde el valor persistido YA es sin IVA; en ese caso se reconstruye el
 * con-IVA multiplicando por el factor de `porcIva`. Los campos de catálogo que
 * el pedido no guarda (`stockTotal`, `habilitado`, `sincronizadoAt`) se
 * defaultean; el `uid` es único por índice+sku.
 */
export function pedidoItemsAPresupuestoItems(
  items: PedidoItemDetalle[],
  skuGenerico?: string | null,
): PresupuestoItem[] {
  return items.map((it, i) => {
    const porcIva = it.porcIva;
    const factor = porcIva != null && porcIva > 0 ? 1 + porcIva / 100 : 1;
    const precio = it.precioUnitario ?? 0;
    // `precioUnitario` es CON IVA salvo cuando aplicaIva === false (perfil sin IVA,
    // p.ej. maquinaria): ahí el valor persistido YA es sin IVA y se reconstruye el con-IVA.
    const conIva = it.aplicaIva === false ? precio * factor : precio;
    const sinIva = it.aplicaIva === false ? precio : precio / factor;
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
