package ar.com.leo.showroom.dux.model;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;
import lombok.ToString;

import java.util.List;

@Getter
@Setter
@NoArgsConstructor
@ToString
@JsonIgnoreProperties(ignoreUnknown = true)
public class DuxItem {

    @JsonProperty("cod_item")
    private String codItem;

    @JsonProperty("item")
    private String item;

    @JsonProperty("codigos_barra")
    private List<String> codigosBarra;

    @JsonProperty("rubro")
    private DuxRubro rubro;

    @JsonProperty("costo")
    private String costo;

    @JsonProperty("porc_iva")
    private String porcIva;

    @JsonProperty("habilitado")
    private String habilitado;

    @JsonProperty("codigo_externo")
    private String codigoExterno;

    @JsonProperty("precios")
    private List<DuxPrecio> precios;

    @JsonProperty("stock")
    private List<DuxStock> stock;
}
