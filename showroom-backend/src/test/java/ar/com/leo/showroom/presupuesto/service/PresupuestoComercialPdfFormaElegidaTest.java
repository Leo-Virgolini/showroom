package ar.com.leo.showroom.presupuesto.service;

import ar.com.leo.showroom.presupuesto.dto.GenerarPresupuestoRequestDTO.FormaPagoSnapshot;
import org.junit.jupiter.api.Test;

import java.math.BigDecimal;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class PresupuestoComercialPdfFormaElegidaTest {

    /** Constructor del record (11 args, en orden):
     *  id, nombre, recargoPorcentaje, cantidadCuotas, aplicaIva, precioFinal,
     *  descripcion, monedaSimbolo, itemSku, recargoPorcentajeMaquinaria, aplicaIvaMaquinaria. */
    private static FormaPagoSnapshot forma(Long id, String nombre, BigDecimal recargo,
                                           Boolean aplicaIva, BigDecimal recargoMaq, Boolean aplicaIvaMaq) {
        return new FormaPagoSnapshot(id, nombre, recargo, 1, aplicaIva,
                BigDecimal.ZERO, null, null, null, recargoMaq, aplicaIvaMaq);
    }

    @Test
    void resolverFormaElegida_idNull_devuelveNull() {
        var f = forma(7L, "Transferencia", BigDecimal.ZERO, true, null, null);
        assertThat(PresupuestoComercialPdfGenerator.resolverFormaElegida(List.of(f), null)).isNull();
    }

    @Test
    void resolverFormaElegida_idDesconocido_devuelveNull() {
        var f = forma(7L, "Transferencia", BigDecimal.ZERO, true, null, null);
        assertThat(PresupuestoComercialPdfGenerator.resolverFormaElegida(List.of(f), 99L)).isNull();
    }

    @Test
    void resolverFormaElegida_encuentraPorId() {
        var f = forma(7L, "Transferencia", BigDecimal.ZERO, true, null, null);
        assertThat(PresupuestoComercialPdfGenerator.resolverFormaElegida(List.of(f), 7L)).isSameAs(f);
    }

    @Test
    void etiquetas_sinForma_nombranLaFormaDeReferencia() {
        assertThat(PresupuestoComercialPdfGenerator.etiquetaSubtotal(null, "Efectivo"))
                .isEqualTo("Subtotal efectivo");
        assertThat(PresupuestoComercialPdfGenerator.etiquetaTotal(null, "Efectivo"))
                .isEqualTo("Total efectivo");
        assertThat(PresupuestoComercialPdfGenerator.etiquetaTotal(null, "Transferencia"))
                .as("si la destacada cambia, la etiqueta la sigue")
                .isEqualTo("Total transferencia");
    }

    @Test
    void etiquetas_sinFormaNiReferencia_caenAGenerico() {
        assertThat(PresupuestoComercialPdfGenerator.etiquetaSubtotal(null, null))
                .isEqualTo("Subtotal de referencia");
        assertThat(PresupuestoComercialPdfGenerator.etiquetaTotal(null, null))
                .isEqualTo("Total de referencia");
    }

    @Test
    void etiquetas_conForma_usanNombre() {
        var f = forma(7L, "Transferencia", BigDecimal.ZERO, true, null, null);
        assertThat(PresupuestoComercialPdfGenerator.etiquetaSubtotal(f, "Efectivo"))
                .as("la forma elegida gana sobre la de referencia")
                .isEqualTo("Subtotal Transferencia");
        assertThat(PresupuestoComercialPdfGenerator.etiquetaTotal(f, "Efectivo"))
                .isEqualTo("Total Transferencia");
    }

    @Test
    void headerPrecio_nombraLaFormaDeReferenciaEnMayusculas() {
        assertThat(PresupuestoComercialPdfGenerator.headerPrecioReferencia("Efectivo"))
                .isEqualTo("PRECIO EFECTIVO");
        assertThat(PresupuestoComercialPdfGenerator.headerPrecioReferencia("Transferencia S/F"))
                .isEqualTo("PRECIO TRANSFERENCIA S/F");
    }

    @Test
    void headerPrecio_sinReferencia_caeAGenerico() {
        assertThat(PresupuestoComercialPdfGenerator.headerPrecioReferencia(null))
                .as("menaje y maquinaria con destacadas distintas ⇒ ningún nombre describe la columna")
                .isEqualTo("PRECIO REFERENCIA");
    }

    @Test
    void perfilMenaje_usaRecargoYAplicaIvaBase() {
        var f = forma(7L, "Crédito", new BigDecimal("15"), true, new BigDecimal("20"), false);
        assertThat(f.recargoPerfil(false)).isEqualByComparingTo("15");
        assertThat(f.aplicaIvaPerfil(false)).isTrue();
    }

    @Test
    void perfilMaquinaria_usaRecargoYAplicaIvaMaquinaria() {
        var f = forma(7L, "Crédito", new BigDecimal("15"), true, new BigDecimal("20"), false);
        assertThat(f.recargoPerfil(true)).isEqualByComparingTo("20");
        assertThat(f.aplicaIvaPerfil(true)).isFalse();
    }

    @Test
    void perfilMaquinaria_recargoNull_caeACero() {
        var f = forma(7L, "Crédito", new BigDecimal("15"), true, null, null);
        assertThat(f.recargoPerfil(true)).isEqualByComparingTo("0");
        assertThat(f.aplicaIvaPerfil(true)).isFalse();
    }

    @Test
    void perfilMenaje_aplicaIvaNull_esTrue() {
        var f = forma(7L, "Efectivo", BigDecimal.ZERO, null, null, null);
        assertThat(f.aplicaIvaPerfil(false)).as("menaje sin flag ⇒ true").isTrue();
    }
}
