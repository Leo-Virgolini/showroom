package ar.com.leo.showroom.events;

/**
 * Payload del evento SSE "whatsapp-business" — notifica al frontend cuando se
 * manda (o falla el envío) del PDF por WhatsApp.
 *
 * <p>Se publica desde:
 * <ul>
 *   <li>{@code WhatsappBusinessService.enviarPdfAsync(pedido)} — tras un pedido
 *       OK (auto) o desde el botón en /pedidos (manual). Lleva {@code pedidoId}.</li>
 *   <li>{@code WhatsappBusinessService.enviarPdfSesionAsync(sesion, telefono)} —
 *       desde el botón en /historial para sesiones abandonadas sin pedido.
 *       Lleva {@code sesionId} y {@code pedidoId} es null.</li>
 * </ul>
 *
 * <p>{@code WINDOW_CLOSED} distingue el caso "el cliente no escribió en las
 * últimas 24hs" del resto de fallas — el operador puede pedirle al cliente que
 * le mande un mensaje rápido y reintentar.
 */
public record WhatsappBusinessEvent(
        Estado estado,
        Long pedidoId,
        Long sesionId,
        String telefono,
        String error
) {
    public enum Estado { SENT, FAILED, WINDOW_CLOSED }

    public static WhatsappBusinessEvent sentPedido(Long pedidoId, String telefono) {
        return new WhatsappBusinessEvent(Estado.SENT, pedidoId, null, telefono, null);
    }

    public static WhatsappBusinessEvent failedPedido(Long pedidoId, String telefono, String error) {
        return new WhatsappBusinessEvent(Estado.FAILED, pedidoId, null, telefono, error);
    }

    public static WhatsappBusinessEvent windowClosedPedido(Long pedidoId, String telefono) {
        return new WhatsappBusinessEvent(Estado.WINDOW_CLOSED, pedidoId, null, telefono,
                "El cliente no escribió en las últimas 24hs — fuera de la ventana de WhatsApp.");
    }

    public static WhatsappBusinessEvent sentSesion(Long sesionId, String telefono) {
        return new WhatsappBusinessEvent(Estado.SENT, null, sesionId, telefono, null);
    }

    public static WhatsappBusinessEvent failedSesion(Long sesionId, String telefono, String error) {
        return new WhatsappBusinessEvent(Estado.FAILED, null, sesionId, telefono, error);
    }

    public static WhatsappBusinessEvent windowClosedSesion(Long sesionId, String telefono) {
        return new WhatsappBusinessEvent(Estado.WINDOW_CLOSED, null, sesionId, telefono,
                "El cliente no escribió en las últimas 24hs — fuera de la ventana de WhatsApp.");
    }
}
