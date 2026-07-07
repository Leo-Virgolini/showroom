import { PedidoItemDetalle, PresupuestoItem } from './models';

/**
 * Hidrata los ítems de un pedido (`PedidoItemDetalle`) como `PresupuestoItem`
 * para el `carrito-editor`. Congela el precio del pedido: `precioUnitario`
 * (con IVA) → `pvpKtGastroConIva`, y deriva `pvpKtGastroSinIva` desde `porcIva`.
 * Los campos de catálogo que el pedido no guarda (`stockTotal`, `habilitado`,
 * `sincronizadoAt`) se defaultean; el `uid` es único por índice+sku.
 */
export function pedidoItemsAPresupuestoItems(
  items: PedidoItemDetalle[],
  skuGenerico?: string | null,
): PresupuestoItem[] {
  return items.map((it, i) => {
    const conIva = it.precioUnitario ?? 0;
    const porcIva = it.porcIva;
    const sinIva = porcIva != null && porcIva > 0 ? conIva / (1 + porcIva / 100) : conIva;
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
