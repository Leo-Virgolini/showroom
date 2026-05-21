package ar.com.leo.showroom.showroom.dto;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;

/**
 * Request para agregar {@code cantidad} unidades de {@code sku} al carrito.
 * Usado por el endpoint del operador {@code POST /carrito/items} y también
 * por el endpoint público del visor {@code POST /visor/agregar-carrito}.
 *
 * <p>{@code forzar=true} le indica al servicio que ignore las restricciones
 * de stock: agrega la cantidad pedida aunque el stock sea 0 o aunque exceda
 * el disponible. Solo lo expone el operador desde la página principal; el
 * visor (cliente) siempre lo deja en false.
 */
public record CarritoAgregarRequestDTO(
        @NotBlank(message = "sku requerido")
        String sku,

        @Min(value = 1, message = "cantidad mínima 1")
        @Max(value = 9999, message = "cantidad máxima 9999")
        int cantidad,

        Boolean forzar
) {
    public boolean forzarFlag() {
        return Boolean.TRUE.equals(forzar);
    }
}
