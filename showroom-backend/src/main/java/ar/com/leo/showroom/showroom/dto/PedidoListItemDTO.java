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
        /** Cuándo se anuló (si aplica). Null si el pedido no fue anulado. */
        Instant anuladoAt,
        EstadoPedido estado,
        Long nroDoc,
        /** Placeholder fijo "PEDIDO SHOWROOM" que va a DUX como `apellido_razon_social`.
         *  No es el nombre real del cliente — eso vive en `nombre`. */
        String apellidoRazonSocial,
        /** Nombre y apellido (o razón social) real del cliente. Es el campo que se
         *  muestra en la columna Cliente del listado. Null si el operador no lo cargó. */
        String nombre,
        /** Total CON IVA — lo que se manda a DUX en el comprobante. */
        BigDecimal total,
        /** Total SIN IVA — lo que efectivamente paga el cliente en el showroom. */
        BigDecimal totalSinIva,
        Integer descuentoPorcentaje,
        int cantidadItems
) {
}
