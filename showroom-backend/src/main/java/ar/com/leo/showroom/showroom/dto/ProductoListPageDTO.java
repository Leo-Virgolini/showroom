package ar.com.leo.showroom.showroom.dto;

import java.util.List;

public record ProductoListPageDTO(
        List<ProductoListItemDTO> items,
        long total,
        int page,
        int size
) {
}
