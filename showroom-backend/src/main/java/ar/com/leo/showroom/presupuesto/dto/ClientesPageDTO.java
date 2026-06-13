package ar.com.leo.showroom.presupuesto.dto;

import java.util.List;

/** Página de clientes para el listado paginado de /clientes. Mismo shape que
 *  {@link PresupuestoListPageDTO} para que el frontend reuse el patrón lazy. */
public record ClientesPageDTO(
        List<ClientePresupuestosDTO> items,
        long total,
        int page,
        int size
) {}
