package ar.com.leo.showroom.events;

/**
 * Spring ApplicationEvent disparado por {@code SesionShowroomService} al cerrar
 * una sesión de atención al cliente sin que haya derivado en un pedido. Lo
 * escucha {@code CarritoService} para vaciar el carrito del cliente saliente —
 * sino el siguiente cliente hereda los items del anterior.
 *
 * <p>El cierre con pedido OK ({@code finalizarConPedido}) NO emite este evento:
 * en ese flujo el carrito ya queda limpio como parte del armado del pedido.
 *
 * <p>Se publica vía {@code ApplicationEventPublisher} (no por el bus SSE) porque
 * es comunicación entre services del backend, no hacia el frontend. El
 * broadcast SSE del carrito vacío lo hace {@code CarritoService.vaciar} cuando
 * el listener procesa el evento.
 */
public record SesionCerradaEvent(Long sesionId, String nombreCliente, String username, Motivo motivo) {

    /** Cómo se cerró la sesión — útil para listeners que quieran distinguir
     *  acción explícita del operador vs. cierre automático al iniciar otra. */
    public enum Motivo {
        /** Operador cerró la sesión activamente desde la UI. */
        CANCELADA,
        /** Sesión activa que se cerró automáticamente al iniciar una nueva. */
        ABANDONADA,
        /** Sesión activa que se cerró porque la atención terminó en presupuesto
         *  comercial (no en pedido). El listener del carrito la vacía igual. */
        PRESUPUESTO
    }
}
