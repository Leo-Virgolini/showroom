package ar.com.leo.showroom.showroom.dto;

import java.math.BigDecimal;
import java.time.Instant;

/**
 * Resultado del scan: lo que necesita la pantalla del showroom para mostrar 1 fila.
 *
 * @param pvpKtGastroSinIva PVP de la lista KT GASTRO con IVA descontado
 * @param sincronizadoAt   Instante en que el cache se actualizó por última vez
 * @param stockStale       true si el stock está más viejo que el threshold configurado
 */
public record ScanResultDTO(
        String sku,
        String descripcion,
        BigDecimal pvpKtGastroConIva,
        BigDecimal pvpKtGastroSinIva,
        BigDecimal porcIva,
        Integer stockTotal,
        Boolean habilitado,
        String imagenUrl,
        Instant sincronizadoAt,
        boolean stockStale
) {
}
