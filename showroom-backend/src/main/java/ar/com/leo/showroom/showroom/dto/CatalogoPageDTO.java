package ar.com.leo.showroom.showroom.dto;

import java.util.List;

/**
 * Página de resultados de búsqueda del catálogo cacheado.
 */
public record CatalogoPageDTO(
        List<CatalogoItemDTO> items,
        long total,
        int page,
        int size
) {
}
