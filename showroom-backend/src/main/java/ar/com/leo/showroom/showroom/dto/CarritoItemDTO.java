package ar.com.leo.showroom.showroom.dto;

import java.math.BigDecimal;
import java.time.Instant;

/**
 * Item del carrito server-side: misma forma que {@link ScanResultDTO} + {@code cantidad}.
 * Plano (no anidado) para que el frontend lo trate como un {@code CarritoItem
 * extends ScanResult} sin transformación intermedia.
 */
public record CarritoItemDTO(
        String sku,
        String descripcion,
        String rubro,
        BigDecimal pvpKtGastroConIva,
        BigDecimal pvpKtGastroSinIva,
        BigDecimal porcIva,
        Integer stockTotal,
        Boolean habilitado,
        String imagenUrl,
        Instant sincronizadoAt,
        int cantidad
) {
    public static CarritoItemDTO from(ScanResultDTO scan, int cantidad) {
        return new CarritoItemDTO(
                scan.sku(),
                scan.descripcion(),
                scan.rubro(),
                scan.pvpKtGastroConIva(),
                scan.pvpKtGastroSinIva(),
                scan.porcIva(),
                scan.stockTotal(),
                scan.habilitado(),
                scan.imagenUrl(),
                scan.sincronizadoAt(),
                cantidad);
    }

    public CarritoItemDTO withCantidad(int nueva) {
        return new CarritoItemDTO(
                sku, descripcion, rubro, pvpKtGastroConIva, pvpKtGastroSinIva, porcIva,
                stockTotal, habilitado, imagenUrl, sincronizadoAt, nueva);
    }

    public CarritoItemDTO conScanActualizado(ScanResultDTO scan) {
        return new CarritoItemDTO(
                scan.sku(),
                scan.descripcion(),
                scan.rubro(),
                scan.pvpKtGastroConIva(),
                scan.pvpKtGastroSinIva(),
                scan.porcIva(),
                scan.stockTotal(),
                scan.habilitado(),
                scan.imagenUrl(),
                scan.sincronizadoAt(),
                cantidad);
    }

    /**
     * Aplica los campos "frescos" de DUX (stock + flags de sincronización)
     * preservando los precios que el cliente vio al momento de agregar. Si
     * DUX modificó un precio entre el scan y el envío del pedido, el cliente
     * paga lo que vio — no le trasladamos cambios de precio inesperados.
     *
     * <p>También se actualizan descripción / imagen / habilitado porque son
     * metadatos informativos: si DUX marcó algo como deshabilitado, el
     * operador debe enterarse.
     */
    public CarritoItemDTO withStockFrescoDe(ScanResultDTO scan) {
        return new CarritoItemDTO(
                scan.sku(),
                scan.descripcion(),
                scan.rubro(),
                pvpKtGastroConIva,
                pvpKtGastroSinIva,
                porcIva,
                scan.stockTotal(),
                scan.habilitado(),
                scan.imagenUrl(),
                scan.sincronizadoAt(),
                cantidad);
    }
}
