package ar.com.leo.showroom.dux.model;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

@Getter
@Setter
@NoArgsConstructor
@JsonIgnoreProperties(ignoreUnknown = true)
public class DuxProvincia {

    /** id interno de DUX — usado para filtrar localidades. */
    @JsonProperty("id")
    private Long id;

    @JsonProperty("id_pais")
    private Long idPais;

    @JsonProperty("provincia")
    private String provincia;

    /** Código ISO ("B", "C", ...) — el que DUX espera como `codigo_provincia` en el pedido. */
    @JsonProperty("cod_iso")
    private String codIso;

    @JsonProperty("pais")
    private String pais;
}
