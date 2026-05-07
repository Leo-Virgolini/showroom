package ar.com.leo.showroom.showroom.dto;

import java.math.BigDecimal;

/**
 * Item liviano del catálogo cacheado, pensado para listas de etiquetas QR
 * y búsquedas (no incluye timestamps de sync).
 *
 * @param imagenUrl URL del endpoint local de imagen del producto, o null si
 *                  el archivo no existe en la carpeta indexada.
 * @param stockTotal Stock total sumado de todos los depósitos. Null si nunca
 *                   se sincronizó.
 */
public record CatalogoItemDTO(
        String sku,
        String descripcion,
        BigDecimal pvpKtGastroSinIva,
        Boolean habilitado,
        String imagenUrl,
        Integer stockTotal
) {
}
