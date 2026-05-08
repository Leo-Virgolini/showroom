package ar.com.leo.showroom.auth.dto;

public record ActualizarUsuarioRequestDTO(
        String nombre,
        boolean activo
) {
}
