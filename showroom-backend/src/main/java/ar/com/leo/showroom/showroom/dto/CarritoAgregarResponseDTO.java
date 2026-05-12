package ar.com.leo.showroom.showroom.dto;

/**
 * Respuesta del endpoint {@code POST /carrito/items} y de {@code /visor/agregar-carrito}.
 * Incluye el estado del carrito tras la mutación + metadata sobre la operación
 * (cuánto pidió el cliente y cuánto realmente se sumó). El visor usa esto para
 * mostrar al cliente la cantidad real (en lugar del "Agregado x10" optimista).
 */
public record CarritoAgregarResponseDTO(
        CarritoStateDTO carrito,
        int cantidadPedida,
        int cantidadAgregada,
        boolean recortado,
        String motivo
) {
}
