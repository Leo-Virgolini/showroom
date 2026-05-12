package ar.com.leo.showroom.showroom.dto;

/**
 * Payload del evento SSE {@code visor-add-cart-rejected} — el backend lo emite
 * cuando el operador notifica que un "agregar al carrito" del visor no se
 * cumplió como pidió el cliente (carrito ya al tope o recortado por stock).
 *
 * <p>El visor lo escucha, filtra por sku actual y muestra toast warn al
 * cliente: "solo se agregaron X de Y".
 */
public record VisorAddRejectedEventDTO(
        String sku,
        int intentada,
        int agregada
) {
}
