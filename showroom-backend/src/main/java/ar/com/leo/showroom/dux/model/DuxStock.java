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
public class DuxStock {

    @JsonProperty("id")
    private int id;

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
