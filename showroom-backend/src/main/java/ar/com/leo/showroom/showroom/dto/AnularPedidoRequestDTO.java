package ar.com.leo.showroom.showroom.dto;

import jakarta.validation.constraints.Size;

/**
 * Body opcional del endpoint POST /pedidos/{id}/anular. El motivo es texto libre
 * que el operador puede tipear; null o blank significa "sin motivo".
 */
public record AnularPedidoRequestDTO(
        @Size(max = 500, message = "El motivo no puede superar los 500 caracteres")
        String motivo
) {
}
