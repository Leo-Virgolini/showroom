package ar.com.leo.showroom.showroom.dto;

/**
 * KPI de "salud" del showroom: del total de sesiones de atención al cliente,
 * cuántas terminaron en pedido (no anulado). El frontend muestra
 * {@code sesionesConPedido / sesionesFinalizadas * 100} como un % grande.
 *
 * @param sesionesFinalizadas total de sesiones cerradas (con
 *                            {@code finalizadaAt != null}) en el rango.
 * @param sesionesConPedido   subset de {@code sesionesFinalizadas} cuya
 *                            sesión terminó en un pedido NO anulado.
 */
public record TasaConversionGlobalDTO(
        long sesionesFinalizadas,
        long sesionesConPedido
) {
}
