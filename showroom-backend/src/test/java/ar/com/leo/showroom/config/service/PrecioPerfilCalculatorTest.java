package ar.com.leo.showroom.config.service;

import org.junit.jupiter.api.Test;

import java.math.BigDecimal;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Fija el comportamiento de {@link PrecioPerfilCalculator#calcularPrecioFinal}
 * por perfil de IVA. Esta es la fórmula que ahora usa TAMBIÉN el payload a DUX
 * ({@code ShowroomService.construirPayloadDux}): a DUX se sube exactamente el
 * precio que paga el cliente según el perfil del rubro, no siempre con IVA.
 *
 * <p>Regresión: antes el payload DUX forzaba {@code aplicaIva=true} (vía el
 * extinto {@code calcularPrecioParaDux}), así que una línea de maquinaria en una
 * forma s/IVA se facturaba con IVA y el operador "absorbía" la diferencia.
 */
class PrecioPerfilCalculatorTest {

    // Base de lista CON IVA = 121 con IVA 21% → sin IVA = 100. Recargo Efectivo -13%.
    private static final BigDecimal BASE_CON_IVA = new BigDecimal("121");
    private static final BigDecimal IVA_21 = new BigDecimal("21");
    private static final BigDecimal RECARGO_EFECTIVO = new BigDecimal("-13");

    @Test
    void menaje_aplica_iva_factura_con_iva() {
        // 100 sin IVA → -13% = 87 → + IVA 21% = 105.27.
        BigDecimal precio = PrecioPerfilCalculator.calcularPrecioFinal(
                BASE_CON_IVA, IVA_21, RECARGO_EFECTIVO, true);

        assertThat(precio)
                .as("menaje en Efectivo: precio CON IVA")
                .isEqualByComparingTo("105.27");
    }

    @Test
    void maquinaria_sin_iva_factura_sin_iva() {
        // Mismo recargo, pero el perfil maquinaria NO vuelve a sumar IVA → 87.
        BigDecimal precio = PrecioPerfilCalculator.calcularPrecioFinal(
                BASE_CON_IVA, IVA_21, RECARGO_EFECTIVO, false);

        assertThat(precio)
                .as("maquinaria en Efectivo: precio SIN IVA (lo que va a DUX)")
                .isEqualByComparingTo("87");
    }

    @Test
    void la_linea_sin_iva_factura_menos_que_con_iva() {
        BigDecimal conIva = PrecioPerfilCalculator.calcularPrecioFinal(
                BASE_CON_IVA, IVA_21, RECARGO_EFECTIVO, true);
        BigDecimal sinIva = PrecioPerfilCalculator.calcularPrecioFinal(
                BASE_CON_IVA, IVA_21, RECARGO_EFECTIVO, false);

        assertThat(sinIva)
                .as("la línea s/IVA debe facturar menos: ya no se 'absorbe' IVA")
                .isLessThan(conIva);
        // Relación exacta: conIva = sinIva * 1.21.
        assertThat(sinIva.multiply(new BigDecimal("1.21")))
                .isEqualByComparingTo(conIva);
    }
}
