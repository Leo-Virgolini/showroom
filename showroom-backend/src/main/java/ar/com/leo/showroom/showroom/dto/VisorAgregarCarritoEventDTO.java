package ar.com.leo.showroom.showroom.dto;

/**
 * Payload del evento SSE {@code visor-add-cart} — el backend lo emite cuando
 * un cliente desde {@code /visor} agregó un item al carrito y pasó las
 * validaciones (precio, stock). La pantalla del operador escucha este evento
 * para sumar el item a su carrito local sin que tenga que tocar nada.
 *
 * <p>Incluye el {@link ScanResultDTO} completo del producto para que el
 * frontend no necesite hacer un lookup extra al recibirlo.
 */
public record VisorAgregarCarritoEventDTO(
        ScanResultDTO scan,
        int cantidad
) {
}
