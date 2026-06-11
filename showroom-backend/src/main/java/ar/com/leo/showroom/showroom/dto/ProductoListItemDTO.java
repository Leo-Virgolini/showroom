package ar.com.leo.showroom.showroom.dto;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;

/**
 * Vista detallada del cache local para la pantalla de listado de productos.
 * Incluye stock, precio c/IVA y timestamp de última sync, que `CatalogoItemDTO`
 * omite por ser pensado para etiquetas QR.
 */
public record ProductoListItemDTO(
        String sku,
        String descripcion,
        /** Rubro DUX del producto (ej. "MAQUINAS INDUSTRIALES"). */
        String rubro,
        BigDecimal pvpKtGastroConIva,
        BigDecimal pvpKtGastroSinIva,
        BigDecimal porcIva,
        Integer stockTotal,
        Boolean habilitado,
        String imagenUrl,
        /** Códigos de barra (EAN-13 u otros) ordenados alfabéticamente. */
        List<String> codigosBarra,
        Instant sincronizadoAt,
        /** Nombre del proveedor en DUX. Null si no informado. */
        String proveedor
) {
}
