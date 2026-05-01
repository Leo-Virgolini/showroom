package ar.com.leo.showroom.showroom.dto;

import java.util.List;

public record PedidoListPageDTO(
        List<PedidoListItemDTO> items,
        long total,
        int page,
        int size
) {
}
