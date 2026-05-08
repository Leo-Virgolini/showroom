package ar.com.leo.showroom.auth.dto;

/**
 * Datos del usuario actualmente autenticado, que devuelve {@code GET /api/auth/me}
 * para que el frontend muestre "Hola, X" y sepa quién está logueado.
 */
public record UsuarioActualDTO(
        Long id,
        String username,
        String nombre
) {
}
