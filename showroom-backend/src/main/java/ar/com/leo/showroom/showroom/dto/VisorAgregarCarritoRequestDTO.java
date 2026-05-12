package ar.com.leo.showroom.showroom.dto;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;

/**
 * Payload del endpoint {@code POST /visor/agregar-carrito} — un cliente desde
 * la pantalla {@code /visor} pidió sumar {@code cantidad} unidades de
 * {@code sku} al carrito del operador. El backend valida stock y precio
 * contra el cache local; si pasa, publica un evento SSE que la pantalla del
 * operador escucha para actualizar su carrito.
 */
public record VisorAgregarCarritoRequestDTO(
        @NotBlank(message = "sku requerido")
        String sku,

        @Min(value = 1, message = "cantidad mínima 1")
        @Max(value = 9999, message = "cantidad máxima 9999")
        int cantidad
) {
}
