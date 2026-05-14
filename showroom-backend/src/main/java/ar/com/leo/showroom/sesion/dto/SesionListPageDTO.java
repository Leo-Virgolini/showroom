package ar.com.leo.showroom.sesion.dto;

import java.util.List;

public record SesionListPageDTO(
        List<SesionListItemDTO> items,
        long total,
        int page,
        int size
) {
}
