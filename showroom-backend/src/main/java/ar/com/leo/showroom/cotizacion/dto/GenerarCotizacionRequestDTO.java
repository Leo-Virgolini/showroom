package ar.com.leo.showroom.cotizacion.dto;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Positive;

import java.math.BigDecimal;
import java.util.List;

/**
 * Payload del POST {@code /cotizacion-financiera/preview} y {@code /enviar}.
 * Contiene el monto base + datos opcionales del cliente + snapshot de las
 * formas de pago con precios ya calculados por el frontend.
 */
public record GenerarCotizacionRequestDTO(
        String clienteNombre,
        String clienteTelefono,
        String clienteEmail,
        /** Rubro comercial del cliente (bar, restaurant, etc.) — string libre. */
        String rubro,
        String observaciones,

        /** Monto base SIN IVA — el operador lo ingresa así. Es lo que el
         *  presupuesto cubre antes de aplicar el IVA y/o el recargo financiero
         *  de cada forma de pago. Debe ser > 0. */
        @NotNull
        @Positive(message = "El monto debe ser mayor a cero")
        BigDecimal montoBaseSinIva,

        /** % de IVA aplicado. Default 21 si viene null. Las formas con
         *  {@code aplicaIva=true} usan {@code monto × (1 + porcIva/100)} como
         *  base; las que no, usan el monto directo. */
        BigDecimal porcIva,

        @NotEmpty(message = "La cotización debe incluir al menos una forma de pago")
        @Valid
        List<FormaPagoSnapshot> formasPago
) {

    /** Mismo shape que {@code PresupuestoComercialDTO.FormaPagoSnapshot} —
     *  duplicado en este paquete para no acoplar cotización a presupuesto.
     *  El JSON serializado es idéntico. */
    public record FormaPagoSnapshot(
            Long id,
            @NotNull String nombre,
            BigDecimal recargoPorcentaje,
            Integer cantidadCuotas,
            Boolean aplicaIva,
            /** Precio FINAL que ve el cliente para esta forma. Lo calcula el
             *  frontend y se persiste tal cual para que el PDF lo muestre sin
             *  doble cálculo. */
            @NotNull BigDecimal precioFinal,
            String descripcion,
            String monedaSimbolo
    ) {}
}
