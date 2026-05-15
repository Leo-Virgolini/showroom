package ar.com.leo.showroom.sesion.dto;

import jakarta.validation.constraints.NotBlank;

/**
 * Body de {@code POST /api/showroom/sesiones/{id}/whatsapp} — el operador
 * carga el teléfono destinatario en el dialog del historial al mandar el
 * PDF de una sesión abandonada por WhatsApp.
 *
 * <p>El formato del teléfono se normaliza en el backend
 * ({@code WhatsappBusinessService.normalizarTelefono}) — el operador puede
 * tipear con o sin código de país, espacios y guiones.
 */
public record SesionEnvioWhatsappRequestDTO(
        @NotBlank(message = "El teléfono es requerido")
        String telefono
) {
}
