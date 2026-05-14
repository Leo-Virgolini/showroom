package ar.com.leo.showroom.sesion.dto;

import java.time.Instant;

/**
 * Estado de la sesión activa expuesto al frontend (vía GET y SSE). Es plano
 * — el listado de items se entrega aparte en {@link SesionDetalleDTO}.
 *
 * <p>{@code id == null} cuando no hay sesión activa.
 */
public record SesionShowroomDTO(
        Long id,
        String nombre,
        Instant iniciadaAt,
        Instant finalizadaAt,
        Long pedidoId,
        int cantidadEscaneados
) {
    /** Construye un placeholder "sin sesión activa". */
    public static SesionShowroomDTO inactiva() {
        return new SesionShowroomDTO(null, null, null, null, null, 0);
    }
}
