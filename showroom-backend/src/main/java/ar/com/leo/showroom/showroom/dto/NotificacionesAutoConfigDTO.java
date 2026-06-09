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
        Boolean emailAutoPedido,
        Boolean whatsappAutoPedido
) {
    /** Ausente/null ⇒ true (default histórico: envíos auto activos). Son
     *  {@code Boolean} (no primitivos) porque Jackson 3 falla al mapear un
     *  primitivo ausente/null ({@code FAIL_ON_NULL_FOR_PRIMITIVES} true por
     *  default); con primitivos, un PUT que omitiera un toggle rompía el endpoint. */
    public NotificacionesAutoConfigDTO {
        emailAutoPedido = emailAutoPedido == null || emailAutoPedido;
        whatsappAutoPedido = whatsappAutoPedido == null || whatsappAutoPedido;
    }
}
