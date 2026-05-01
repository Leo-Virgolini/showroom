package ar.com.leo.showroom.showroom.dto;

import ar.com.leo.showroom.pedido.entity.EstadoPedido;

import java.math.BigDecimal;
import java.time.Instant;

/**
 * Vista resumida de un pedido para el listado. No incluye items ni respuesta DUX
 * cruda — eso va en {@link PedidoDetailDTO} cuando se expande la fila.
 */
public record PedidoListItemDTO(
        Long id,
        Instant creadoAt,
        Instant enviadoAt,
        EstadoPedido estado,
        String idDuxRespuesta,
        Long nroDoc,
        /** Nombre/razón social del cliente para mostrar en el listado y permitir buscarlo. */
        String apellidoRazonSocial,
        /** Total CON IVA — lo que se manda a DUX en el comprobante. */
        BigDecimal total,
        /** Total SIN IVA — lo que efectivamente paga el cliente en el showroom. */
        BigDecimal totalSinIva,
        Integer descuentoPorcentaje,
        int cantidadItems
) {
}
