package ar.com.leo.showroom.showroom.dto;

/**
 * Configuración runtime de la integración con el programa pickit-y-etiquetas.
 * Persistida fila por fila en la tabla {@code configuracion} (una clave por
 * campo de este DTO). El front la lee/edita desde la pantalla de configuración.
 *
 * <p>Todos los paths se interpretan dentro del container Docker del backend
 * — el host expone las carpetas vía volúmenes en docker-compose. Ejemplo:
 * si el host monta {@code D:/Pickit} en {@code /mnt/pickit}, el jarPath sería
 * {@code /mnt/pickit/pickit-y-etiquetas.jar}.
 */
public record PickitConfigDTO(
        boolean enabled,
        String jarPath,
        String stockFile,
        String combosFile,
        String outputDir
) {
}
