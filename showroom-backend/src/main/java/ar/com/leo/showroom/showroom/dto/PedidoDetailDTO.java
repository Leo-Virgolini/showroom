package ar.com.leo.showroom.showroom.dto;

import ar.com.leo.showroom.pedido.entity.EstadoPedido;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;

public record PedidoDetailDTO(
        Long id,
        Instant creadoAt,
        Instant enviadoAt,
        /** Cuándo se anuló (si aplica). Null si el pedido no fue anulado. */
        Instant anuladoAt,
        /** Motivo libre que el operador tipeó al anular. Null/blank si no se especificó. */
        String motivoAnulacion,
        EstadoPedido estado,
        String respuestaDux,
        Long nroDoc,
        String tipoDoc,
        /** Razón social del cliente (editable, va a DUX como `apellido_razon_social`).
         *  Pedidos legacy podían traer el placeholder "PEDIDO SHOWROOM"/"PRESUPUESTO". */
        String apellidoRazonSocial,
        /** Nombre de contacto informal del cliente (opcional). Null si no se cargó. */
        String nombre,
        String telefono,
        String email,
        String domicilio,
        String codigoProvincia,
        /** Nombre legible de la provincia, ya resuelto. Null si no se pudo resolver. */
        String provinciaNombre,
        String idLocalidad,
        /** Nombre legible de la localidad, ya resuelto. Null si no se pudo resolver. */
        String localidadNombre,
        /** Total que pagó el cliente. Incluye recargo si hubo financiación. Tiene
         *  IVA cuando {@code formaPagoAplicaIva} es true/null (caso normal); está
         *  sin IVA cuando es false (forma "sin IVA": DUX igual facturó c/IVA pero
         *  el operador absorbió la diferencia — ver {@code items} para reconstruir
         *  el total DUX). */
        BigDecimal total,
        /** Total sin IVA del pedido (recargo aplicado, IVA descontado). Cuando
         *  {@code formaPagoAplicaIva=false} coincide con {@code total}. */
        BigDecimal totalSinIva,
        BigDecimal descuentoPorcentaje,
        /** Forma de pago elegida (FK). Null si no se eligió. */
        Long formaPagoId,
        /** Snapshot del nombre — sobrevive si se desactiva/borra la forma. */
        String formaPagoNombre,
        /** % de recargo que se aplicó. Null si no hubo. */
        BigDecimal recargoPorcentaje,
        /** Cantidad de cuotas — informativo. */
        Integer cantidadCuotas,
        /** Snapshot del flag aplicaIva de la forma de pago al momento del pedido.
         *  Null si no hubo forma de pago. */
        Boolean formaPagoAplicaIva,
        /** Total con IVA antes del recargo financiero (referencia). Null si no
         *  hubo recargo. Útil para mostrar en UI/PDF "antes / después". */
        BigDecimal totalSinRecargo,
        String observaciones,
        List<PedidoItemDTO> items
) {
}
