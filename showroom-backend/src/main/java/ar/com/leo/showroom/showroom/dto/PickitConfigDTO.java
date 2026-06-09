package ar.com.leo.showroom.showroom.dto;

/**
 * Configuración runtime de la integración con el programa pickit-y-etiquetas.
 * Persistida fila por fila en la tabla {@code configuracion} (una clave por
 * campo persistido). El front la lee/edita desde la pantalla de configuración.
 *
 * <p>Todos los paths se interpretan dentro del container Docker del backend
 * — el host expone las carpetas vía volúmenes en docker-compose. Ejemplo:
 * si el host monta {@code D:/Pickit} en {@code /app/pickit}, el jarPath sería
 * {@code /app/pickit/pickit-y-etiquetas.jar}.
 *
 * <p>{@code hostPath} es read-only: lo completa el backend leyendo la env var
 * {@code SHOWROOM_PICKIT_HOST_PATH} (mapeada desde {@code PICKIT_HOST_PATH} en
 * docker-compose) y el frontend lo muestra para que el operador sepa a qué
 * carpeta del host equivale {@code /app/pickit}. Lo que mande el cliente en
 * el PUT se ignora.
 */
public record PickitConfigDTO(
        Boolean enabled,
        String jarPath,
        String stockFile,
        String combosFile,
        String outputDir,
        String hostPath
) {
    /** {@code enabled} ausente/null ⇒ false. Es {@code Boolean} (no primitivo)
     *  porque Jackson 3 falla al mapear un primitivo ausente/null
     *  ({@code FAIL_ON_NULL_FOR_PRIMITIVES} true por default). */
    public PickitConfigDTO {
        enabled = enabled != null && enabled;
    }
}
