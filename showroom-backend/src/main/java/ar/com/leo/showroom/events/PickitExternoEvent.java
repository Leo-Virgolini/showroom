package ar.com.leo.showroom.events;

/**
 * Payload del SSE {@code pickit-externo} — notifica al frontend cuándo se
 * generó (o falló) el pickit externo (programa Java desktop pickit-y-etiquetas)
 * para un pedido. El frontend lo muestra como toast.
 *
 * <p>{@code outputPath} solo está presente en eventos {@code GENERATED} —
 * permite que la pantalla del operador muestre la ruta exacta del archivo
 * generado en el host.
 *
 * <p>{@code clientId} es el identificador de la pestaña/PC que originó el
 * pedido (header {@code X-Client-Id} de la request). El frontend lo usa para
 * que <b>solo la PC origen auto-descargue</b> el .xlsx; las demás muestran
 * únicamente el toast. {@code null} si la request no incluyó el header
 * (ej. clientes viejos) — en ese caso nadie auto-descarga.
 */
public record PickitExternoEvent(
        Estado estado,
        Long pedidoId,
        String outputPath,
        String error,
        String clientId
) {
    public enum Estado { GENERATED, FAILED }

    public static PickitExternoEvent generated(Long pedidoId, String outputPath, String clientId) {
        return new PickitExternoEvent(Estado.GENERATED, pedidoId, outputPath, null, clientId);
    }

    public static PickitExternoEvent failed(Long pedidoId, String error, String clientId) {
        return new PickitExternoEvent(Estado.FAILED, pedidoId, null, error, clientId);
    }
}
