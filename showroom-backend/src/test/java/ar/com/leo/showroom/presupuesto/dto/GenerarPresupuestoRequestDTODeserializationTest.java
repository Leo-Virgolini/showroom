package ar.com.leo.showroom.presupuesto.dto;

import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * El campo opcional {@code formaPagoSeleccionadaId} debe tolerar ausencia/null
 * (presupuestos en modo "Todas") y respetar el id cuando viene poblado.
 */
class GenerarPresupuestoRequestDTODeserializationTest {

    private final JsonMapper mapper = JsonMapper.builder().build();

    private static final String SIN_FORMA = """
            {"items":[{"sku":"1011002","cantidad":1,"precioConIva":1000}],
             "formasPago":[]}
            """;

    @Test
    void ausente_se_deserializa_como_null() {
        GenerarPresupuestoRequestDTO dto = mapper.readValue(SIN_FORMA, GenerarPresupuestoRequestDTO.class);
        assertThat(dto.formaPagoSeleccionadaId())
                .as("ausente ⇒ null (modo Todas)")
                .isNull();
    }

    @Test
    void id_explicito_se_respeta() {
        String json = """
                {"formaPagoSeleccionadaId":7,
                 "items":[{"sku":"1","cantidad":1,"precioConIva":1000}],
                 "formasPago":[]}
                """;
        GenerarPresupuestoRequestDTO dto = mapper.readValue(json, GenerarPresupuestoRequestDTO.class);
        assertThat(dto.formaPagoSeleccionadaId()).isEqualTo(7L);
    }

    @Test
    void origenAtencionSesionId_explicito_se_respeta() {
        String json = """
                {"items":[{"sku":"1","cantidad":1,"precioConIva":1000}],
                 "origenAtencionSesionId": 42}
                """;
        GenerarPresupuestoRequestDTO dto = mapper.readValue(json, GenerarPresupuestoRequestDTO.class);
        assertThat(dto.origenAtencionSesionId()).isEqualTo(42L);
    }

    @Test
    void origenAtencionSesionId_ausente_se_deserializa_como_null() {
        GenerarPresupuestoRequestDTO dto = mapper.readValue(SIN_FORMA, GenerarPresupuestoRequestDTO.class);
        assertThat(dto.origenAtencionSesionId())
                .as("ausente ⇒ null (flujo normal del presupuestador, no toca ninguna sesión)")
                .isNull();
    }
}
