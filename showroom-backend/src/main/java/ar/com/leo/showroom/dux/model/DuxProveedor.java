package ar.com.leo.showroom.dux.model;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;
import lombok.ToString;

/**
 * Proveedor de un item en la respuesta de DUX {@code GET /items}. Solo se
 * capturan el id y el nombre — lo único que el showroom necesita para el filtro
 * por proveedor del catálogo. El resto de campos del proveedor (domicilio,
 * contacto, etc.) se ignoran ({@code ignoreUnknown}).
 */
@Getter
@Setter
@NoArgsConstructor
@ToString
@JsonIgnoreProperties(ignoreUnknown = true)
public class DuxProveedor {

    @JsonProperty("id_proveedor")
    private Integer idProveedor;

    @JsonProperty("proveedor")
    private String proveedor;
}
