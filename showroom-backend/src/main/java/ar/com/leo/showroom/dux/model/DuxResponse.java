package ar.com.leo.showroom.dux.model;

import tools.jackson.annotation.JsonIgnoreProperties;
import tools.jackson.annotation.JsonProperty;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

import java.util.List;

@Getter
@Setter
@NoArgsConstructor
@JsonIgnoreProperties(ignoreUnknown = true)
public class DuxResponse {

    @JsonProperty("results")
    private List<DuxItem> results;

    @JsonProperty("paging")
    private DuxPaging paging;
}
