package ar.com.leo.showroom.showroom.dto;

import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;

/**
 * Payload del endpoint {@code POST /visor-add-rejected} — el operador notifica
 * al backend que un "agregar al carrito" disparado desde el visor no se pudo
 * cumplir completamente: el carrito ya tenía la cantidad máxima por stock o
 * sólo se pudo agregar una parte. El backend reenvía esa info como SSE al
 * visor para que el cliente vea un toast con la verdad.
 */
public record VisorAddRejectedRequestDTO(
        @NotBlank(message = "sku requerido")
        String sku,

        @Min(value = 1, message = "intentada mínima 1")
        int intentada,

        @Min(value = 0, message = "agregada no puede ser negativa")
        int agregada
) {
}
