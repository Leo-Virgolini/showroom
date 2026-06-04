package ar.com.leo.showroom.showroom.dto;

import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.Digits;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

import java.math.BigDecimal;

/**
 * DTO para exponer una {@link ar.com.leo.showroom.config.entity.FormaPago} y
 * para crear/editar desde la pantalla de configuración.
 *
 * <p>{@code id} es null al crear, presente al editar.
 * {@code creadoAt} se ignora al crear/editar (lo setea el backend).
 */
public record FormaPagoDTO(
        Long id,

        @NotBlank(message = "El nombre es requerido")
        @Size(max = 100, message = "El nombre no puede superar los 100 caracteres")
        String nombre,

        @NotNull(message = "El recargo es requerido (usar 0 si no hay)")
        @DecimalMin(value = "-99.99", message = "El recargo no puede ser menor a -99,99% (descuento)")
        @Digits(integer = 4, fraction = 2, message = "Recargo con máximo 4 dígitos enteros y 2 decimales")
        BigDecimal recargoPorcentaje,

        /** Recargo % del perfil maquinaria. Null = usa {@link #recargoPorcentaje}. */
        @DecimalMin(value = "-99.99", message = "El recargo de maquinaria no puede ser menor a -99,99%")
        @Digits(integer = 4, fraction = 2, message = "Recargo de maquinaria con máximo 4 dígitos enteros y 2 decimales")
        BigDecimal recargoPorcentajeMaquinaria,

        @NotNull(message = "La cantidad de cuotas es requerida")
        @Min(value = 1, message = "Mínimo 1 cuota")
        Integer cantidadCuotas,

        /** Si la forma agrega IVA al precio. Default true (la mayoría de las
         *  ventas con factura). Solo se setea false en casos especiales como
         *  "transferencia sin IVA" o ventas exentas. */
        Boolean aplicaIva,

        /** Aplica IVA del perfil maquinaria. Null = false (sin IVA). */
        Boolean aplicaIvaMaquinaria,

        Boolean activo,

        Integer orden,

        /** Si la forma se muestra como precio de referencia (perfil menaje) en
         *  scan/visor/carrito. Default false si viene null. */
        Boolean precioReferencia,

        /** Si la forma se muestra como precio de referencia para el perfil
         *  maquinaria. Default false si viene null. */
        Boolean precioReferenciaMaquinaria,

        String creadoAt
) {
}
