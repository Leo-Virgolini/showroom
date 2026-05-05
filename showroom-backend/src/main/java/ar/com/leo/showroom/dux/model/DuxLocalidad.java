package ar.com.leo.showroom.dux.model;

import tools.jackson.annotation.JsonIgnoreProperties;
import tools.jackson.annotation.JsonProperty;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

@Getter
@Setter
@NoArgsConstructor
@JsonIgnoreProperties(ignoreUnknown = true)
public class DuxLocalidad {

    @JsonProperty("id")
    private Long id;

    /** Id numérico de la provincia — refiere a {@link DuxProvincia#getId()}. */
    @JsonProperty("id_provincia")
    private Long idProvincia;

    @JsonProperty("localidad")
    private String localidad;

    @JsonProperty("cod_postal")
    private String codPostal;
}
