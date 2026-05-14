package ar.com.leo.showroom.sesion.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/** Body de {@code POST /api/showroom/sesion/iniciar}. */
public record IniciarSesionRequestDTO(
        @NotBlank(message = "Nombre requerido")
        @Size(max = 150, message = "Nombre demasiado largo (máx 150)")
        String nombre
) {
}
