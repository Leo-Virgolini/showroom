package ar.com.leo.showroom.presupuesto.dto;

import java.math.BigDecimal;
import java.time.Instant;

/**
 * Resumen ligero para la pantalla {@code /presupuestos/historial}. No
 * incluye los items ni las formas de pago (los JSON crudos del entity)
 * para mantener el payload chico — si el operador necesita el PDF lo
 * descarga via {@code GET /presupuesto-comercial/{id}/pdf}.
 */
public record PresupuestoListItemDTO(
        Long id,
        Instant creadoAt,
        /** Última edición del presupuesto. Null si no se editó desde que se
         *  generó — el frontend muestra un pill "Editado el …" cuando hay valor. */
        Instant modificadoAt,
        String clienteNombre,
        String clienteTelefono,
        String clienteEmail,
        String rubro,
        BigDecimal totalSinIva,
        BigDecimal descuentoGlobalPorcentaje,
        /** Nombre o username del operador que generó el presupuesto. Null en
         *  presupuestos legacy creados antes del multi-usuario. */
        String creadoPor,
        /** Si este presupuesto fue transformado en pedido vía "Crear pedido"
         *  del historial, acá viene el id del pedido. Null = todavía
         *  pendiente. El frontend muestra "→ Pedido #N" cuando aplica. */
        Long convertidoEnPedidoId,
        /** Cuándo se (re)generó el pedido. Null si nunca se convirtió. El
         *  frontend compara con {@link #modificadoAt} para ofrecer "Regenerar
         *  pedido" solo cuando el presupuesto se editó tras la conversión. */
        Instant convertidoAt
) {}
