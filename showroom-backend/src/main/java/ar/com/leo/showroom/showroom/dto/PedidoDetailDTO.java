package ar.com.leo.showroom.showroom.dto;

import ar.com.leo.showroom.pedido.entity.EstadoPedido;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;

public record PedidoDetailDTO(
        Long id,
        Instant creadoAt,
        Instant enviadoAt,
        EstadoPedido estado,
        String idDuxRespuesta,
        String respuestaDux,
        Long nroDoc,
        String tipoDoc,
        String apellidoRazonSocial,
        String telefono,
        String email,
        String domicilio,
        String codigoProvincia,
        /** Nombre legible de la provincia, ya resuelto. Null si no se pudo resolver. */
        String provinciaNombre,
        String idLocalidad,
        /** Nombre legible de la localidad, ya resuelto. Null si no se pudo resolver. */
        String localidadNombre,
        /** Total CON IVA — el del comprobante DUX. */
        BigDecimal total,
        /** Total SIN IVA — lo que paga el cliente. */
        BigDecimal totalSinIva,
        Integer descuentoPorcentaje,
        String observaciones,
        List<PedidoItemDTO> items
) {
}
