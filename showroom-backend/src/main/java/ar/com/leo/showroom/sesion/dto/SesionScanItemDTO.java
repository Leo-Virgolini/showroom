package ar.com.leo.showroom.sesion.dto;

import java.math.BigDecimal;
import java.time.Instant;

/**
 * Item escaneado durante una sesión — snapshot al momento del scan, no
 * refleja cambios posteriores de DUX.
 *
 * <p>{@code compradoEnPedido} indica si el SKU terminó incluido en el pedido
 * asociado a la sesión. Solo es significativo cuando la sesión tiene
 * {@code pedidoId} no nulo; en sesiones abandonadas siempre es {@code false}.
 */
public record SesionScanItemDTO(
        Long id,
        String sku,
        String descripcion,
        BigDecimal precioConIva,
        BigDecimal porcIva,
        String imagenUrl,
        Instant escaneadoAt,
        boolean compradoEnPedido
) {
}
