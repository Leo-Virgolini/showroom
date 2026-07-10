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
public class DuxStock {

    // Wrapper (no primitivo): Jackson 3 tiene FAIL_ON_NULL_FOR_PRIMITIVES=true por
    // default, así que un "id": null de DUX rompería el parseo de toda la página.
    @JsonProperty("id")
    private Integer id;

    @JsonProperty("nombre")
    private String nombre;

    @JsonProperty("ctd_disponible")
    private String ctdDisponible;

    @JsonProperty("stock_real")
    private String stockReal;

    @JsonProperty("stock_reservado")
    private String stockReservado;

    @JsonProperty("stock_disponible")
    private String stockDisponible;
}
