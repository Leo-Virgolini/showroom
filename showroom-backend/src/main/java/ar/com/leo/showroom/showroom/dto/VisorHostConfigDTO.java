package ar.com.leo.showroom.showroom.dto;

/**
 * Host:puerto del servidor para el QR del visor (ej. {@code 192.168.1.50:4200}).
 * Cadena vacía = no configurado, el frontend cae al host del browser.
 */
public record VisorHostConfigDTO(String host) {
}
