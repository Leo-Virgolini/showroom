package ar.com.leo.showroom.showroom.dto;

import ar.com.leo.showroom.pedido.entity.EstadoPedido;

import java.time.Instant;

public record CrearPedidoResponseDTO(
        Long pedidoLocalId,
        String idDuxRespuesta,
        EstadoPedido estado,
        Instant enviadoAt,
        String mensaje
) {
}
