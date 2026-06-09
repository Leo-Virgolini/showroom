package ar.com.leo.showroom.showroom.dto;

import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Regresión del mismo gotcha de Jackson 3 (FAIL_ON_NULL_FOR_PRIMITIVES) en los
 * DTOs de configuración con flags booleanos: un PUT que omita un flag no debe
 * romper el endpoint, sino caer al default documentado de cada DTO.
 */
class ConfigDTODeserializationTest {

    private final JsonMapper mapper = JsonMapper.builder().build();

    @Test
    void pickit_enabled_ausente_es_false() {
        PickitConfigDTO dto = mapper.readValue("{\"jarPath\":\"/app/x.jar\"}", PickitConfigDTO.class);
        assertThat(dto.enabled()).isFalse();
    }

    @Test
    void pickit_enabled_true_se_respeta() {
        PickitConfigDTO dto = mapper.readValue("{\"enabled\":true}", PickitConfigDTO.class);
        assertThat(dto.enabled()).isTrue();
    }

    @Test
    void notificaciones_ausentes_default_true() {
        // Default histórico: si nunca se setearon, los envíos auto están activos.
        NotificacionesAutoConfigDTO dto = mapper.readValue("{}", NotificacionesAutoConfigDTO.class);
        assertThat(dto.emailAutoPedido()).isTrue();
        assertThat(dto.whatsappAutoPedido()).isTrue();
    }

    @Test
    void notificaciones_false_explicito_se_respeta() {
        // Operador que desactiva un canal: false debe mantenerse, no volver a true.
        NotificacionesAutoConfigDTO dto = mapper.readValue(
                "{\"emailAutoPedido\":false}", NotificacionesAutoConfigDTO.class);
        assertThat(dto.emailAutoPedido()).as("false explícito se respeta").isFalse();
        assertThat(dto.whatsappAutoPedido()).as("el omitido cae al default true").isTrue();
    }
}
