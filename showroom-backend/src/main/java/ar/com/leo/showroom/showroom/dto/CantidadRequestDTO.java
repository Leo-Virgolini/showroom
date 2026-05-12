package ar.com.leo.showroom.showroom.dto;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;

/**
 * Request para {@code PATCH /carrito/items/{sku}} — fijar la cantidad de un
 * item ya presente al valor que mande el cliente. Si el item no existe, el
 * endpoint responde 404.
 */
public record CantidadRequestDTO(
        @Min(value = 1, message = "cantidad mínima 1")
        @Max(value = 9999, message = "cantidad máxima 9999")
        int cantidad
) {
}
