package ar.com.leo.showroom.cotizacion.dto;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;

/**
 * Snapshot completo de una cotización persistida — pre-llena la pantalla
 * {@code /cotizador/editar/:id} con todos los campos del original. Las
 * formas se rehidratan del JSON serializado.
 */
public record CotizacionDetalleDTO(
        Long id,
        Instant creadoAt,
        Instant modificadoAt,
        String clienteNombre,
        String clienteTelefono,
        String clienteEmail,
        String rubro,
        String observaciones,
        BigDecimal montoBaseSinIva,
        BigDecimal porcIva,
        List<GenerarCotizacionRequestDTO.FormaPagoSnapshot> formasPago
) {}
