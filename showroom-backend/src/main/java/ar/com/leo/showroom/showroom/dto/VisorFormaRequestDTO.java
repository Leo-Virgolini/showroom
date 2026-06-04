package ar.com.leo.showroom.showroom.dto;

import jakarta.validation.constraints.NotNull;

/**
 * Request para {@code POST /visor/forma} — la forma de pago que el operador
 * eligió en el scan. El backend la reemite al visor del operador (SSE
 * {@code visor-forma}) para que la pantalla del cliente muestre el precio con
 * esa misma forma.
 */
public record VisorFormaRequestDTO(
        @NotNull(message = "formaId requerido")
        Long formaId
) {
}
