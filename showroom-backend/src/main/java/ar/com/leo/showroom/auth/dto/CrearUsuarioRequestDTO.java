package ar.com.leo.showroom.auth.dto;

import jakarta.validation.constraints.NotBlank;

public record CrearUsuarioRequestDTO(
        @NotBlank String username,
        @NotBlank String password,
        String nombre,
        Boolean activo
) {
}
