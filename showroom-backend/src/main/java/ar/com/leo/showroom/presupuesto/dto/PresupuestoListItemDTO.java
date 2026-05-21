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
        String clienteNombre,
        String clienteTelefono,
        String clienteEmail,
        String rubro,
        BigDecimal totalSinIva,
        BigDecimal descuentoGlobalPorcentaje
) {}
