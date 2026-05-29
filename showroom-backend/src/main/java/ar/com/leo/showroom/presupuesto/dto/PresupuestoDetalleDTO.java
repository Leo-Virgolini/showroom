package ar.com.leo.showroom.presupuesto.dto;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;

/**
 * Snapshot completo de un presupuesto comercial persistido — todo lo necesario
 * para reconstruir el estado de la pantalla {@code /presupuestos} al editarlo.
 *
 * <p>El frontend lo consume en {@code GET /presupuesto-comercial/{id}/detalle}
 * para pre-llenar el formulario en modo edición. Después del PUT
 * {@code /presupuesto-comercial/{id}}, se actualiza la entity in-place
 * (mismo número), se setea {@link #modificadoAt} y se regenera el PDF.
 */
public record PresupuestoDetalleDTO(
        Long id,
        Instant creadoAt,
        Instant modificadoAt,
        String clienteNombre,
        String clienteTelefono,
        String clienteEmail,
        String rubro,
        String observaciones,
        BigDecimal descuentoGlobalPorcentaje,
        Boolean cotizacionIndividual,
        /**
         * Id del pedido DUX si este presupuesto ya fue convertido. Null si
         * sigue pendiente. La pantalla de edición lo usa para mostrar el
         * pill "→ Pedido #N" en lugar del botón "Crear pedido" y evitar
         * la doble conversión cuando otro operador abre un presupuesto que
         * ya pasó a pedido.
         */
        Long convertidoEnPedidoId,
        List<GenerarPresupuestoRequestDTO.Item> items,
        List<GenerarPresupuestoRequestDTO.FormaPagoSnapshot> formasPago
) {}
