package ar.com.leo.showroom.showroom.dto;

import java.math.BigDecimal;

/**
 * Item liviano del catálogo cacheado, pensado para listas de etiquetas QR
 * y búsquedas (no incluye stock ni timestamps de sync).
 *
 * @param imagenUrl URL del endpoint local de imagen del producto, o null si
 *                  el archivo no existe en la carpeta indexada.
 */
public record CatalogoItemDTO(
        String sku,
        String descripcion,
        BigDecimal pvpKtGastroSinIva,
        Boolean habilitado,
        String imagenUrl
) {
}
