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
public class DuxPaging {

    // Wrappers (no primitivos): Jackson 3 tiene FAIL_ON_NULL_FOR_PRIMITIVES=true por
    // default, así que un "total": null de DUX rompería el parseo de toda la página
    // y — al hacer break el sync — dejaría el catálogo incompleto marcado como fresco.
    // Los getters devuelven int con default 0 para preservar el contrato del call site
    // (DuxClient hace `int t = getPaging().getTotal()`), sin mover el NPE al unboxing.
    @JsonProperty("total")
    private Integer total;

    @JsonProperty("offset")
    private Integer offset;

    @JsonProperty("limit")
    private Integer limit;

    public int getTotal() {
        return total != null ? total : 0;
    }

    public int getOffset() {
        return offset != null ? offset : 0;
    }

    public int getLimit() {
        return limit != null ? limit : 0;
    }
}
