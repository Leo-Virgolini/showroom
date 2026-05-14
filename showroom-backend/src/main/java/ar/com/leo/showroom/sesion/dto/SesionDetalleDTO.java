package ar.com.leo.showroom.sesion.dto;

import java.time.Instant;
import java.util.List;

/** Sesión + sus items para el detalle de la página /historial. */
public record SesionDetalleDTO(
        Long id,
        String nombre,
        Instant iniciadaAt,
        Instant finalizadaAt,
        Long pedidoId,
        List<SesionScanItemDTO> items
) {
}
