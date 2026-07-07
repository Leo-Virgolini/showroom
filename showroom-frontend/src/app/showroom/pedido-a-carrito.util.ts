import { PedidoItemDetalle, PresupuestoItem } from './models';

/**
 * Hidrata los ítems de un pedido (`PedidoItemDetalle`) como `PresupuestoItem`
 * para el `carrito-editor`. Congela el precio del pedido usando
 * `precioListaConIva` — el PVP de lista PRE-forma (correcto para editar sin
 * duplicar el recargo/descuento de la forma de pago). Este campo del backend
 * es SIEMPRE con IVA (es `precioBaseConIva` = `pvpKtGastroConIva`),
 * independientemente del perfil de IVA del ítem. Los pedidos anteriores a
 * esta columna no lo tienen (null): se cae a `precioUnitario` como
 * aproximación (ese valor es POST-forma, así que la pantalla de edición
 * re-cotiza esos ítems a la lista vigente por separado); en ese fallback sí
 * hay que respetar `aplicaIva === false` (perfil sin IVA, p.ej. maquinaria),
 * donde el valor persistido YA es sin IVA y se reconstruye el con-IVA
 * multiplicando por el factor de `porcIva`. Los campos de catálogo que el
 * pedido no guarda (`stockTotal`, `habilitado`, `sincronizadoAt`) se
 * defaultean; el `uid` es único por índice+sku.
 */
export function pedidoItemsAPresupuestoItems(
  items: PedidoItemDetalle[],
  skuGenerico?: string | null,
): PresupuestoItem[] {
  return items.map((it, i) => {
    const porcIva = it.porcIva;
    const factor = porcIva != null && porcIva > 0 ? 1 + porcIva / 100 : 1;
    // `precioListaConIva` (backend) es SIEMPRE con IVA. Fallback para pedidos viejos
    // (null): `precioUnitario` es con IVA salvo aplicaIva===false (perfil sin IVA),
    // donde el valor persistido ya es sin IVA y se reconstruye el con-IVA.
    const conIva =
      it.precioListaConIva != null
        ? it.precioListaConIva
        : it.aplicaIva === false
          ? (it.precioUnitario ?? 0) * factor
          : (it.precioUnitario ?? 0);
    const sinIva = conIva / factor;
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
