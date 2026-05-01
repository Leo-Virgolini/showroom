package ar.com.leo.showroom.showroom.dto;

import jakarta.validation.constraints.NotEmpty;

import java.util.List;

/**
 * Request genérico con una lista de SKUs. Usado por refresh-stock (refresca contra DUX)
 * y por lookup (consulta solo cache local).
 */
public record SkusRequestDTO(
        @NotEmpty(message = "skus no puede estar vacío")
        List<String> skus
) {
}
