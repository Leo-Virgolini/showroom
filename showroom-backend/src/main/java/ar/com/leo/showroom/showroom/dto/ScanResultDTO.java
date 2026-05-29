package ar.com.leo.showroom.showroom.dto;

import java.math.BigDecimal;
import java.time.Instant;

/**
 * Resultado del scan: lo que necesita la pantalla del showroom para mostrar 1 fila.
 *
 * @param pvpKtGastroSinIva PVP de la lista KT GASTRO con IVA descontado
 * @param rubro            Rubro DUX del producto (ej. "MAQUINAS INDUSTRIALES").
 *                         El frontend lo usa para excluir ese rubro de los
 *                         descuentos generales por escala.
 * @param sincronizadoAt   Instante en que el cache se actualizó por última vez
 */
public record ScanResultDTO(
        String sku,
        String descripcion,
        String rubro,
        BigDecimal pvpKtGastroConIva,
        BigDecimal pvpKtGastroSinIva,
        BigDecimal porcIva,
        Integer stockTotal,
        Boolean habilitado,
        String imagenUrl,
        Instant sincronizadoAt
) {
}
