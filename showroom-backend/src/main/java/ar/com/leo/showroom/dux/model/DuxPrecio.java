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
public class DuxPrecio {

    // Wrapper (no primitivo): Jackson 3 tiene FAIL_ON_NULL_FOR_PRIMITIVES=true por
    // default, así que un "id": null de DUX rompería el parseo de toda la página.
    @JsonProperty("id")
    private Long id;

    @JsonProperty("nombre")
    private String nombre;

    @JsonProperty("precio")
    private String precio;
}
