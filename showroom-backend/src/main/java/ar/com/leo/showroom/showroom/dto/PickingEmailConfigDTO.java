package ar.com.leo.showroom.showroom.dto;

/**
 * Destinatario del email de picking. Acepta uno o varios mails separados por
 * coma. Cadena vacía significa "usar el default de application.properties"
 * (efectivamente: deshabilitar el envío si tampoco hay default).
 */
public record PickingEmailConfigDTO(String email) {
}
