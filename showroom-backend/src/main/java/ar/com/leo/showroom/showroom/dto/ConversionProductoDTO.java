package ar.com.leo.showroom.showroom.dto;

/**
 * Conversión de un producto: veces escaneado vs unidades efectivamente
 * vendidas en pedidos no anulados. Sirve para identificar productos
 * "gancho" (alta conversión) o "vidriera" (mucho mirado, poca venta).
 *
 * @param sku           SKU del producto.
 * @param descripcion   snapshot de la descripción (último valor visto).
 * @param escaneados    cantidad de sesiones donde se escaneó.
 * @param comprados     suma de unidades vendidas en pedidos no anulados.
 * @param porcentaje    {@code comprados / escaneados * 100}, redondeado a 1 decimal.
 *                      Si {@code escaneados == 0} (edge case), 0.
 */
public record ConversionProductoDTO(
        String sku,
        String descripcion,
        long escaneados,
        long comprados,
        double porcentaje
) {
}
