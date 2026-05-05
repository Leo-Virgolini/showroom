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
public class DuxPrecio {

    @JsonProperty("id")
    private long id;

    @JsonProperty("nombre")
    private String nombre;

    @JsonProperty("precio")
    private String precio;
}
