package ar.com.leo.showroom.showroom.dto;

import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

import java.math.BigDecimal;

/**
 * Request del dialog "+ Producto genérico" del carrito y del presupuesto.
 * El SKU lo resuelve el backend a partir de {@code dux.sku-producto-generico};
 * el operador solo tipea la descripción libre, el precio CON IVA, la tasa de
 * IVA y la cantidad.
 */
public record CarritoAgregarGenericoRequestDTO(
        @NotBlank(message = "descripción requerida")
        @Size(max = 500, message = "descripción máxima 500 caracteres")
        String descripcion,

        @NotNull(message = "precio requerido")
        @DecimalMin(value = "0.01", message = "el precio debe ser mayor a 0")
        BigDecimal precioConIva,

        /** Tasa de IVA del producto — típicamente 21 o 10.5 en AR. Si llega
         *  null, el backend asume 21. */
        BigDecimal porcIva,

        @Min(value = 1, message = "cantidad mínima 1")
        @Max(value = 9999, message = "cantidad máxima 9999")
        int cantidad,

        /** Si true, el producto se trata como "máquina industrial": se le
         *  setea {@code rubro=MAQUINAS INDUSTRIALES} para que la lógica
         *  existente de {@code rubroExcluyeDescuentos} lo saque del descuento
         *  por escala. Default false (null se interpreta como false). */
        Boolean maquinaria
) {
        public boolean esMaquinaria() {
                return Boolean.TRUE.equals(maquinaria);
        }
}
