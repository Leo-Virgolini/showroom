package ar.com.leo.showroom.events;

/**
 * Payload del SSE {@code pickit-externo} — notifica al frontend cuándo se
 * generó (o falló) el pickit externo (programa Java desktop pickit-y-etiquetas)
 * para un pedido. El frontend lo muestra como toast.
 *
 * <p>{@code outputPath} solo está presente en eventos {@code GENERATED} —
 * permite que la pantalla del operador muestre la ruta exacta del archivo
 * generado en el host.
 */
public record PickitExternoEvent(
        Estado estado,
        Long pedidoId,
        String outputPath,
        String error
) {
    public enum Estado { GENERATED, FAILED }

    public static PickitExternoEvent generated(Long pedidoId, String outputPath) {
        return new PickitExternoEvent(Estado.GENERATED, pedidoId, outputPath, null);
    }

    public static PickitExternoEvent failed(Long pedidoId, String error) {
        return new PickitExternoEvent(Estado.FAILED, pedidoId, null, error);
    }
}
