package ar.com.leo.showroom.showroom.service;

import ar.com.leo.showroom.showroom.dto.ConversionProductoDTO;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Verifica el orden del "Top productos por conversión"
 * ({@link ShowroomService#ORDEN_CONVERSION}).
 *
 * <p>Regresión de dos bugs reales:
 * <ul>
 *   <li>El doble {@code .reversed()} invertía el comparator compuesto entero,
 *       dejando el orden por % ASCENDENTE (mostraba los de peor conversión).</li>
 *   <li>La ausencia de desempate por sesiones escaneadas hacía que, entre
 *       empatados en 0%, el top se llenara de productos con apenas 2 sesiones
 *       en vez de los más mirados ("vidriera").</li>
 * </ul>
 */
class OrdenConversionTest {

    private static ConversionProductoDTO dto(String sku, long escaneadas, long conCompra, double pct) {
        return new ConversionProductoDTO(sku, sku, escaneadas, conCompra, pct);
    }

    @Test
    void mayor_porcentaje_va_primero() {
        List<ConversionProductoDTO> ordenado = List.of(
                dto("baja", 4, 1, 25.0),
                dto("alta", 3, 1, 33.3),
                dto("cero", 2, 0, 0.0)
        ).stream().sorted(ShowroomService.ORDEN_CONVERSION).toList();

        assertThat(ordenado).extracting(ConversionProductoDTO::sku)
                .as("el de mayor %% de conversión debe quedar primero, no último")
                .containsExactly("alta", "baja", "cero");
    }

    @Test
    void ante_igual_porcentaje_prioriza_los_mas_escaneados() {
        // Tres productos en 0% (caso típico): debe ganar el más escaneado, que
        // es la señal "vidriera". Antes ganaba el de menor SKU (orden GROUP BY).
        List<ConversionProductoDTO> ordenado = List.of(
                dto("9999991", 2, 0, 0.0),
                dto("0000001", 6, 0, 0.0),
                dto("5000000", 4, 0, 0.0)
        ).stream().sorted(ShowroomService.ORDEN_CONVERSION).toList();

        assertThat(ordenado).extracting(ConversionProductoDTO::sesionesEscaneadas)
                .as("entre empatados en 0%%, el más escaneado va primero")
                .containsExactly(6L, 4L, 2L);
    }

    @Test
    void desempate_por_sesiones_con_compra_antes_que_escaneadas() {
        // Igual % (50%): primero el que convirtió a más clientes (4 > 2),
        // aunque el otro tenga más sesiones escaneadas.
        List<ConversionProductoDTO> ordenado = List.of(
                dto("4-compras", 8, 4, 50.0),
                dto("2-compras", 4, 2, 50.0)
        ).stream().sorted(ShowroomService.ORDEN_CONVERSION).toList();

        assertThat(ordenado).extracting(ConversionProductoDTO::sku)
                .containsExactly("4-compras", "2-compras");
    }
}
