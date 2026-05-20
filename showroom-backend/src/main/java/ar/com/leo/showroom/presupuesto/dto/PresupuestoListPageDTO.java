package ar.com.leo.showroom.presupuesto.dto;

import java.util.List;

/** Página de presupuestos para el listado paginado. */
public record PresupuestoListPageDTO(
        List<PresupuestoListItemDTO> items,
        long total,
        int page,
        int size
) {}
