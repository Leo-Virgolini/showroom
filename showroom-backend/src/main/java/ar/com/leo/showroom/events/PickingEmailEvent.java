package ar.com.leo.showroom.events;

/**
 * Payload del evento SSE "picking-email" — notifica al frontend cuando se manda
 * (o falla el envío de) el email de picking que sale después de cada pedido.
 *
 * Se publica desde {@code PickingEmailService.enviarAsync} sobre el bus de
 * SSE; el frontend muestra un toast con el resultado.
 */
public record PickingEmailEvent(
        Estado estado,
        Long pedidoId,
        String cuit,
        String error
) {
    public enum Estado { SENT, FAILED }

    public static PickingEmailEvent sent(Long pedidoId, String cuit) {
        return new PickingEmailEvent(Estado.SENT, pedidoId, cuit, null);
    }

    public static PickingEmailEvent failed(Long pedidoId, String cuit, String error) {
        return new PickingEmailEvent(Estado.FAILED, pedidoId, cuit, error);
    }
}
