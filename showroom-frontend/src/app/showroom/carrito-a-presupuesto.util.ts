import { CarritoItem, PresupuestoItem } from './models';

/**
 * Mapea el carrito del showroom (`CarritoItem`) a los ítems del presupuestador
 * (`PresupuestoItem`) para precargar la pantalla `/presupuestos` desde una
 * atención. Como `CarritoItem extends ScanResult`, todos los campos de catálogo
 * se copian tal cual; el descuento efectivo por ítem (escala por monto +
 * manuales) lo aporta el caller vía `descuentoEfectivo`, que en el showroom es
 * `ShowroomPage.descuentoEfectivoItem`. El `uid` es único por índice+sku (mismo
 * criterio que `pedidoItemsAPresupuestoItems`).
 */
export function carritoItemsAPresupuestoItems(
  items: CarritoItem[],
  descuentoEfectivo: (it: CarritoItem) => number,
): PresupuestoItem[] {
  return items.map((it, i) => ({
    sku: it.sku,
    descripcion: it.descripcion,
    rubro: it.rubro ?? null,
    pvpKtGastroConIva: it.pvpKtGastroConIva,
    pvpKtGastroSinIva: it.pvpKtGastroSinIva,
    porcIva: it.porcIva,
    stockTotal: it.stockTotal,
    habilitado: it.habilitado,
    imagenUrl: it.imagenUrl,
    sincronizadoAt: it.sincronizadoAt,
    uid: `${it.sku}-${i}`,
    cantidad: it.cantidad,
    descuentoPorcentaje: descuentoEfectivo(it),
    generico: it.generico ?? false,
    comentarios: it.comentarios ?? null,
  }));
}
