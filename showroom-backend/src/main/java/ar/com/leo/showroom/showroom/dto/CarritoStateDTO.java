package ar.com.leo.showroom.showroom.dto;

import java.util.List;

/**
 * Estado completo del carrito server-side. Es el payload del SSE
 * {@code carrito-updated} y la respuesta de todos los endpoints mutadores.
 *
 * <p>{@code origen} indica quién disparó el cambio (operador desde {@code /}
 * o cliente desde {@code /visor}). El frontend lo usa para mostrar toast
 * informativo "Cliente agregó X" cuando llega un cambio que no originó la
 * pantalla activa.
 */
public record CarritoStateDTO(
        List<CarritoItemDTO> items,
        Origen origen
) {
    public enum Origen { OPERADOR, VISOR, SISTEMA }

    public static CarritoStateDTO of(List<CarritoItemDTO> items, Origen origen) {
        return new CarritoStateDTO(List.copyOf(items), origen);
    }
}
