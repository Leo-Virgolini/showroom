package ar.com.leo.showroom.sesion.dto;

import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;

/**
 * Body de {@code POST /api/showroom/sesiones/{id}/email} — el operador carga
 * el email destinatario en el dialog del historial al mandar el PDF de una
 * sesión abandonada (sin pedido asociado).
 */
public record SesionEnvioEmailRequestDTO(
        @NotBlank(message = "El email es requerido")
        @Email(message = "Formato de email inválido")
        String email
) {
}
