package ar.com.leo.showroom.showroom.dto;

import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Regresión: el flujo showroom normal crea el pedido SIN {@code origenPresupuesto}.
 * Con un componente {@code boolean} primitivo, Jackson 3 fallaba al deserializar
 * (FAIL_ON_NULL_FOR_PRIMITIVES es true por default). El campo es {@code Boolean}
 * normalizado a false en el constructor compacto para tolerar ausencia/null.
 */
class CrearPedidoRequestDTODeserializationTest {

    private final JsonMapper mapper = JsonMapper.builder().build();

    private static final String BASE_SIN_FLAG = """
            {"apellidoRazonSocial":"X","nombre":"Cliente","telefono":"1130000000",
             "email":"cliente@dominio.com","rubro":"bar",
             "items":[{"sku":"1011002","cantidad":1}]}
            """;

    @Test
    void ausente_se_deserializa_como_false() {
        CrearPedidoRequestDTO dto = mapper.readValue(BASE_SIN_FLAG, CrearPedidoRequestDTO.class);
        assertThat(dto.origenPresupuesto())
                .as("ausente en el payload ⇒ false (flujo showroom normal)")
                .isFalse();
    }

    @Test
    void null_explicito_se_deserializa_como_false() {
        String json = """
                {"nombre":"Cliente","telefono":"1","email":"c@d.com","rubro":"bar",
                 "origenPresupuesto":null,"items":[{"sku":"1","cantidad":1}]}
                """;
        CrearPedidoRequestDTO dto = mapper.readValue(json, CrearPedidoRequestDTO.class);
        assertThat(dto.origenPresupuesto()).isFalse();
    }

    @Test
    void true_explicito_se_respeta() {
        String json = """
                {"nombre":"Cliente","telefono":"1","email":"c@d.com","rubro":"bar",
                 "origenPresupuesto":true,"items":[{"sku":"1","cantidad":1}]}
                """;
        CrearPedidoRequestDTO dto = mapper.readValue(json, CrearPedidoRequestDTO.class);
        assertThat(dto.origenPresupuesto()).isTrue();
    }
}
