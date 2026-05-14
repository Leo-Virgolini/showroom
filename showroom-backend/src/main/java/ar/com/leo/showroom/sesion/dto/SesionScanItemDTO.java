package ar.com.leo.showroom.sesion.dto;

import java.math.BigDecimal;
import java.time.Instant;

/**
 * Item escaneado durante una sesión — snapshot al momento del scan, no
 * refleja cambios posteriores de DUX.
 */
public record SesionScanItemDTO(
        Long id,
        String sku,
        String descripcion,
        BigDecimal precioConIva,
        BigDecimal porcIva,
        String imagenUrl,
        Instant escaneadoAt
) {
}
