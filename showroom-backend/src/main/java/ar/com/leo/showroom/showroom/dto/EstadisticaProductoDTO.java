package ar.com.leo.showroom.showroom.dto;

/**
 * Punto en un ranking de productos (top escaneados / top comprados) que
 * alimenta los charts de la pantalla de historial.
 *
 * @param sku         identificador del producto.
 * @param descripcion descripción legible — para el tooltip / label del chart.
 * @param total       conteo (escaneados) o suma de cantidades (comprados).
 */
public record EstadisticaProductoDTO(
        String sku,
        String descripcion,
        Long total
) {
}
