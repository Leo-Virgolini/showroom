package ar.com.leo.showroom.cotizacion.dto;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.PositiveOrZero;

import java.math.BigDecimal;
import java.util.List;

/**
 * Payload del POST {@code /cotizacion-financiera/preview} y {@code /enviar}.
 * Contiene los montos base + datos opcionales del cliente + snapshot de las
 * formas de pago con precios ya calculados por el frontend.
 *
 * <p>Soporta cotizar hasta dos montos con tasas de IVA distintas (caso típico:
 * una máquina con 21% + un insumo con 10.5%). El frontend manda los precios
 * finales por forma calculados sobre la suma respetando el IVA propio de
 * cada monto.
 */
public record GenerarCotizacionRequestDTO(
        String clienteNombre,
        String clienteTelefono,
        String clienteEmail,
        /** Rubro comercial del cliente (bar, restaurant, etc.) — string libre. */
        String rubro,
        String observaciones,

        /** Monto base CON IVA principal (el operador lo carga con IVA, igual
         *  que en scan/presupuesto). Puede ser null/cero cuando el operador
         *  cotiza usando solo el segundo monto — se valida en el service que
         *  al menos uno de los dos sea > 0. */
        @PositiveOrZero
        BigDecimal montoBaseConIva,

        /** % de IVA del monto principal. Default 21 si viene null. El monto ya
         *  viene con IVA; el cotizador deriva el neto cuando lo necesita
         *  ({@code monto / (1 + porcIva/100)}). */
        BigDecimal porcIva,

        /** Segundo monto base CON IVA (opcional). Cotiza junto al
         *  {@link #montoBaseConIva} principal — las formas se calculan sobre
         *  la suma respetando el IVA propio de cada monto. Null o 0 = no se
         *  usa el segundo monto. */
        @PositiveOrZero
        BigDecimal montoBaseConIva2,

        /** % de IVA del segundo monto. Default 10.5 (productos esenciales)
         *  cuando {@link #montoBaseConIva2} > 0 y este viene null. */
        BigDecimal porcIva2,

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
