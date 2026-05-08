package ar.com.leo.showroom.auth.dto;

/**
 * Vista de un usuario para el listado/edición. NO incluye el hash del password.
 */
public record UsuarioDTO(
        Long id,
        String username,
        String nombre,
        boolean activo
) {
}
