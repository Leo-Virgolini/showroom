package ar.com.leo.showroom.presupuesto.dto;

import java.math.BigDecimal;
import java.time.Instant;

/**
 * Resumen de un cliente reconstruido a partir de los presupuestos guardados.
 * Sirve a la pantalla {@code /presupuestos/clientes} donde el operador ve la
 * lista de personas a las que les armó presupuestos sin tener que entrar al
 * detalle de cada uno.
 *
 * <p>Los clientes se identifican por email cuando hay; sino por teléfono. Si
 * un mismo cliente tiene varios presupuestos con nombre/teléfono distintos
 * pero mismo email, se toman los datos del presupuesto más reciente como
 * canónicos (el operador puede haber tipeado mal en uno viejo).
 */
public record ClientePresupuestosDTO(
        String email,
        String telefono,
        String nombre,
        String rubro,
        int cantidadPresupuestos,
        Instant primerPresupuestoAt,
        Instant ultimoPresupuestoAt,
        BigDecimal ultimoTotalSinIva,
        Long ultimoPresupuestoId
) {
}
