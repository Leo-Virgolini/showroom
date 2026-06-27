package ar.com.leo.showroom.pedido.service;

import org.junit.jupiter.api.Test;

import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

/** El perfil (maquinaria/menaje) se CONGELA desde `precioReferenciaConIva` en
 *  pedidos de presupuesto, y se deriva por rubro en el resto. */
class ResolverEsMaqTest {

    private static final Set<String> RUBROS_MAQ = Set.of("MAQUINAS INDUSTRIALES");

    @Test
    void presupuesto_conFlagFalse_congelaMaquinaria() {
        // flag=false ⇒ se cotizó sin IVA (maquinaria) ⇒ esMaq=true, aunque el rubro no sea maq.
        assertThat(PedidoService.resolverEsMaq(true, Boolean.FALSE, "BAZAR", RUBROS_MAQ)).isTrue();
    }

    @Test
    void presupuesto_conFlagTrue_congelaMenaje() {
        // flag=true ⇒ se cotizó con IVA (menaje) ⇒ esMaq=false, aunque el rubro sea maquinaria.
        assertThat(PedidoService.resolverEsMaq(true, Boolean.TRUE, "MAQUINAS INDUSTRIALES", RUBROS_MAQ)).isFalse();
    }

    @Test
    void presupuesto_sinFlag_derivaPorRubro() {
        assertThat(PedidoService.resolverEsMaq(true, null, "MAQUINAS INDUSTRIALES", RUBROS_MAQ)).isTrue();
        assertThat(PedidoService.resolverEsMaq(true, null, "BAZAR", RUBROS_MAQ)).isFalse();
    }

    @Test
    void showroomNormal_ignoraFlag_yDerivaPorRubro() {
        // origenPresupuesto=false ⇒ siempre por rubro, aunque venga el flag.
        assertThat(PedidoService.resolverEsMaq(false, Boolean.FALSE, "MAQUINAS INDUSTRIALES", RUBROS_MAQ)).isTrue();
        assertThat(PedidoService.resolverEsMaq(false, Boolean.TRUE, "BAZAR", RUBROS_MAQ)).isFalse();
    }
}
