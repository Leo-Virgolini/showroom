package ar.com.leo.showroom.showroom.dto;

/**
 * KPI de "salud" del showroom: del total de sesiones de atención cerradas,
 * cuántas terminaron en pedido (no anulado) y cuántas en presupuesto. El
 * frontend puede derivar abandonadas = finalizadas − conPedido − conPresupuesto.
 *
 * @param sesionesFinalizadas  total de sesiones cerradas (atenciones reales) en el rango.
 * @param sesionesConPedido    subset que terminó en pedido NO anulado.
 * @param sesionesConPresupuesto subset que terminó en presupuesto comercial.
 */
public record TasaConversionGlobalDTO(
        long sesionesFinalizadas,
        long sesionesConPedido,
        long sesionesConPresupuesto
) {
}
