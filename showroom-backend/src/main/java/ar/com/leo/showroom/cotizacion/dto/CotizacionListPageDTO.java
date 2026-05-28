package ar.com.leo.showroom.cotizacion.dto;

import java.util.List;

/** Página paginada de cotizaciones para la pantalla {@code /cotizador/historial}. */
public record CotizacionListPageDTO(
        List<CotizacionListItemDTO> items,
        long total,
        int page,
        int size
) {}
