package ar.com.leo.showroom.events;

/**
 * Payload del evento SSE "picking-email" — notifica al frontend cuando se manda
 * (o falla el envío de) el email de picking que sale después de cada pedido.
 *
 * <p>Se publica desde {@code PickingEmailService.enviarAsync} sobre el bus de
 * SSE; el frontend muestra un toast con el resultado.
 *
 * <p>{@code email} es el destinatario al que se intentó/efectivamente despachó
 * el mail (lo carga el operador en el pedido). Va al toast para que el operador
 * vea de un vistazo a quién le llegó (más útil que el CUIT del cliente).
 */
public record PickingEmailEvent(
        Estado estado,
        Long pedidoId,
        String cuit,
        String email,
        String error
) {
    public enum Estado { SENT, FAILED }

    public static PickingEmailEvent sent(Long pedidoId, String cuit, String email) {
        return new PickingEmailEvent(Estado.SENT, pedidoId, cuit, email, null);
    }

    public static PickingEmailEvent failed(Long pedidoId, String cuit, String email, String error) {
        return new PickingEmailEvent(Estado.FAILED, pedidoId, cuit, email, error);
    }
}
