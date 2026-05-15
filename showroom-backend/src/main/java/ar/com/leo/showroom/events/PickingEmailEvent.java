package ar.com.leo.showroom.events;

/**
 * Payload del evento SSE "picking-email" — notifica al frontend cuando se manda
 * (o falla el envío de) el email con el PDF de productos vistos.
 *
 * <p>Se publica desde:
 * <ul>
 *   <li>{@code PickingEmailService.enviarAsync(pedido)} — tras un pedido OK
 *       (auto) o desde el botón ✉️ en /pedidos (manual). Lleva {@code pedidoId}.</li>
 *   <li>{@code PickingEmailService.enviarPdfSesionAsync(sesion, email)} — desde
 *       el botón ✉️ en /historial para sesiones abandonadas sin pedido.
 *       Lleva {@code sesionId} y {@code pedidoId} es null.</li>
 * </ul>
 *
 * <p>{@code email} es el destinatario al que se intentó/efectivamente despachó
 * el mail. Va al toast para que el operador identifique al cliente.
 */
public record PickingEmailEvent(
        Estado estado,
        Long pedidoId,
        Long sesionId,
        String cuit,
        String email,
        String error
) {
    /** {@code SKIPPED}: no es un error técnico — había una razón legítima para
     *  no mandar el email (ej: cliente compró todo lo que vio, no hay PDF). El
     *  frontend muestra un toast informativo en vez de error. */
    public enum Estado { SENT, FAILED, SKIPPED }

    public static PickingEmailEvent sentPedido(Long pedidoId, String cuit, String email) {
        return new PickingEmailEvent(Estado.SENT, pedidoId, null, cuit, email, null);
    }

    public static PickingEmailEvent failedPedido(Long pedidoId, String cuit, String email, String error) {
        return new PickingEmailEvent(Estado.FAILED, pedidoId, null, cuit, email, error);
    }

    public static PickingEmailEvent skippedPedido(Long pedidoId, String cuit, String email, String motivo) {
        return new PickingEmailEvent(Estado.SKIPPED, pedidoId, null, cuit, email, motivo);
    }

    public static PickingEmailEvent sentSesion(Long sesionId, String email) {
        return new PickingEmailEvent(Estado.SENT, null, sesionId, null, email, null);
    }

    public static PickingEmailEvent failedSesion(Long sesionId, String email, String error) {
        return new PickingEmailEvent(Estado.FAILED, null, sesionId, null, email, error);
    }

    public static PickingEmailEvent skippedSesion(Long sesionId, String email, String motivo) {
        return new PickingEmailEvent(Estado.SKIPPED, null, sesionId, null, email, motivo);
    }
}
