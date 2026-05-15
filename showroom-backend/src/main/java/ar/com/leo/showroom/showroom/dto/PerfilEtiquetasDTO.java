package ar.com.leo.showroom.showroom.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

import java.util.Map;

/**
 * Perfil de impresión de etiquetas (geometría + tipografía + toggles).
 * El {@code config} es opaco al backend — el shape vive en el frontend.
 *
 * <p>{@code id} es null al crear, presente al editar.
 * {@code creadoAt}/{@code actualizadoAt} se ignoran al crear/editar (los setea el backend).
 */
public record PerfilEtiquetasDTO(
        Long id,

        @NotBlank(message = "El nombre es requerido")
        @Size(max = 100, message = "El nombre no puede superar los 100 caracteres")
        String nombre,

        @NotNull(message = "La config es requerida")
        Map<String, Object> config,

        String creadoAt,
        String actualizadoAt
) {
}
