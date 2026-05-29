package ar.com.leo.showroom.showroom.dto;

import java.math.BigDecimal;
import java.time.Instant;

/**
 * Item del carrito server-side: misma forma que {@link ScanResultDTO} + {@code cantidad}.
 * Plano (no anidado) para que el frontend lo trate como un {@code CarritoItem
 * extends ScanResult} sin transformación intermedia.
 *
 * <p>El {@code itemKey} es el identificador único del ítem dentro del carrito
 * de un operador. Para productos del catálogo coincide con el {@code sku}
 * (una sola línea por SKU, merge por re-scan). Para productos genéricos
 * (ver {@code dux.sku-producto-generico}) se genera un uid sintético para
 * permitir varias líneas distintas con el mismo SKU comodín — cada una con
 * su propia descripción + precio. El frontend usa este {@code itemKey} al
 * llamar a los endpoints PATCH/DELETE del carrito.
 */
public record CarritoItemDTO(
        /** Clave única dentro del carrito. Para items normales = sku;
         *  para items genéricos = uid sintético. */
        String itemKey,
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
        int cantidad,
        /** Texto libre que viaja como {@code comentarios} de la línea al
         *  payload DUX. Para items genéricos es la descripción que tipeó el
         *  operador (típicamente igual a {@code descripcion}). Null para items
         *  normales del catálogo. */
        String comentarios,
        /** True si la línea representa un producto genérico (cargado con el
         *  SKU comodín). El frontend lo usa para diferenciar el render en la
         *  tabla y deshabilitar el refresh contra DUX para esa línea. */
        boolean generico
) {
    public static CarritoItemDTO from(ScanResultDTO scan, int cantidad) {
        return new CarritoItemDTO(
                scan.sku(),
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
                cantidad,
                null,
                false);
    }

    /** Constructor para items genéricos cargados desde el dialog "+ Producto
     *  genérico". {@code sku} es el SKU comodín (config), {@code itemKey} es
     *  un uid sintético generado por el caller para que varias líneas con el
     *  mismo SKU coexistan. {@code rubro} permite marcar el ítem como
     *  {@code MAQUINAS INDUSTRIALES} para que quede excluido del descuento
     *  por escala (la misma helper que para productos del catálogo). */
    public static CarritoItemDTO generico(String itemKey, String sku, String descripcion,
                                          String rubro, BigDecimal precioConIva,
                                          BigDecimal porcIva, int cantidad) {
        BigDecimal sinIva = precioConIva == null || porcIva == null
                ? precioConIva
                : precioConIva.divide(
                        java.math.BigDecimal.ONE.add(porcIva.movePointLeft(2)),
                        4, java.math.RoundingMode.HALF_UP);
        return new CarritoItemDTO(
                itemKey,
                sku,
                descripcion,
                rubro,
                precioConIva,
                sinIva,
                porcIva,
                null,
                true,
                null,
                Instant.now(),
                cantidad,
                descripcion,
                true);
    }

    public CarritoItemDTO withCantidad(int nueva) {
        return new CarritoItemDTO(
                itemKey, sku, descripcion, rubro, pvpKtGastroConIva, pvpKtGastroSinIva, porcIva,
                stockTotal, habilitado, imagenUrl, sincronizadoAt, nueva, comentarios, generico);
    }

    public CarritoItemDTO conScanActualizado(ScanResultDTO scan) {
        return new CarritoItemDTO(
                itemKey,
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
                cantidad,
                comentarios,
                generico);
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
                itemKey,
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
                cantidad,
                comentarios,
                generico);
    }
}
