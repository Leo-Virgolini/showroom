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
        /** Email del cliente. Se incluye en el listado (no solo el detalle) para
         *  que el frontend decida si mostrar el botón "Reenviar email". */
        String email,
        /** Teléfono del cliente. Se incluye en el listado para condicionar el
         *  botón "Enviar por WhatsApp" — si está vacío, el botón se oculta. */
        String telefono,
        /** Total que pagó el cliente (con o sin IVA según la forma — ver
         *  {@code PedidoDetailDTO#formaPagoAplicaIva}). */
        BigDecimal total,
        /** Total sin IVA del pedido. Coincide con {@code total} cuando la forma
         *  de pago no aplica IVA (el cliente pagó sin IVA). */
        BigDecimal totalSinIva,
        BigDecimal descuentoPorcentaje,
        /** Snapshot del nombre de la forma de pago — null si no se eligió. */
        String formaPagoNombre,
        /** Snapshot del flag aplicaIva de la forma — null si no hubo forma. */
        Boolean formaPagoAplicaIva,
        /** Snapshot de la cantidad de cuotas — null si no hubo forma. */
        Integer cantidadCuotas,
        int cantidadItems,
        /** Nombre o username del operador que creó el pedido. Null en pedidos
         *  legacy creados antes del multi-usuario. Se muestra como columna
         *  "Operador" en el listado. */
        String creadoPor
) {
}
