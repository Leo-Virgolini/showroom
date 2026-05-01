package ar.com.leo.showroom.showroom.dto;

import java.math.BigDecimal;

/**
 * Item liviano del catálogo cacheado, pensado para listas de etiquetas QR
 * y búsquedas (no incluye stock ni timestamps de sync).
 */
public record CatalogoItemDTO(
        String sku,
        String descripcion,
        BigDecimal pvpKtGastroSinIva,
        Boolean habilitado
) {
}
