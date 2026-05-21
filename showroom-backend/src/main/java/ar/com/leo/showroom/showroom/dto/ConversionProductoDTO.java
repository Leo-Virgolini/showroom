package ar.com.leo.showroom.showroom.dto;

/**
 * Tasa de conversión real de un producto: porcentaje de sesiones que lo
 * escanearon y terminaron comprándolo. Sirve para identificar productos
 * "gancho" (alta conversión) o "vidriera" (mucho mirado, poca venta).
 *
 * @param sku           SKU del producto.
 * @param descripcion   snapshot de la descripción (último valor visto).
 * @param sesionesEscaneadas  cuántas sesiones únicas escanearon el SKU
 *                      (re-scans dentro de la misma sesión cuentan una sola
 *                      vez — sino el denominador se inflaría).
 * @param sesionesConCompra   cuántas de esas sesiones terminaron en pedido
 *                      no anulado que incluye el SKU.
 * @param porcentaje    {@code sesionesConCompra / sesionesEscaneadas × 100},
 *                      redondeado a 1 decimal. Siempre entre 0 y 100.
 */
public record ConversionProductoDTO(
        String sku,
        String descripcion,
        long sesionesEscaneadas,
        long sesionesConCompra,
        double porcentaje
) {
}
