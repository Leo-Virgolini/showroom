package ar.com.leo.showroom.sesion.dto;

import ar.com.leo.showroom.pedido.entity.EstadoPedido;

import java.time.Instant;

/** Fila del listado paginado en /historial.
 *
 *  <p>{@code estadoPedido} es el estado del pedido asociado (cuando hay uno):
 *  permite que la UI distinga una sesión COMPLETADA cuyo pedido fue luego
 *  ANULADO. {@code null} si la sesión no tiene pedido (abandonada). */
public record SesionListItemDTO(
        Long id,
        String nombre,
        Instant iniciadaAt,
        Instant finalizadaAt,
        Long pedidoId,
        EstadoPedido estadoPedido,
        int cantidadEscaneados,
        /** Nombre o username del operador que atendió la sesión. Null en
         *  sesiones legacy creadas antes del multi-usuario. */
        String creadoPor
) {
}
