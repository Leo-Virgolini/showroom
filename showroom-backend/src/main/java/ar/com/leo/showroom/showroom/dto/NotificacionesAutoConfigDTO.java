package ar.com.leo.showroom.showroom.dto;

/**
 * Toggles de envío automático tras crear un pedido. Solo afectan los disparos
 * automáticos que hace el {@code PdfFollowupOrchestrator} — los botones
 * manuales en /pedidos y /historial siguen funcionando independientemente.
 *
 * <p>Ambos default {@code true}: si nunca se setearon, asumimos que el operador
 * quiere los envíos auto activos (comportamiento histórico).
 */
public record NotificacionesAutoConfigDTO(
        boolean emailAutoPedido,
        boolean whatsappAutoPedido
) {
}
