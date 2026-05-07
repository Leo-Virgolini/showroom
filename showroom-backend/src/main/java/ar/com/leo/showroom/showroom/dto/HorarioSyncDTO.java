package ar.com.leo.showroom.showroom.dto;

/**
 * Horario diario de sincronización automática con DUX expuesto al frontend.
 * Se interpreta en zona America/Argentina/Buenos_Aires.
 */
public record HorarioSyncDTO(
        Integer hora,
        Integer minuto
) {
}
