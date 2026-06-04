package ar.com.leo.showroom.cotizacion.dto;

import java.math.BigDecimal;
import java.time.Instant;

/**
 * Resumen ligero para la pantalla {@code /cotizador/historial}. No incluye
 * el JSON de formas — el operador lo consigue al descargar el PDF.
 */
public record CotizacionListItemDTO(
        Long id,
        Instant creadoAt,
        Instant modificadoAt,
        String clienteNombre,
        String clienteTelefono,
        String clienteEmail,
        String rubro,
        BigDecimal montoBaseConIva,
        /** Nombre o username del operador que generó la cotización. */
        String creadoPor
) {}
