package ar.com.leo.showroom.events;

/**
 * Spring ApplicationEvent disparado por {@code CatalogoSyncService} al
 * terminar exitosamente un sync global del catálogo. Lo escucha
 * {@code CarritoService} para actualizar el stock de los items que tenga el
 * operador en el carrito — sin ese refresh, el operador podría intentar
 * vender una cantidad que ya no hay en DUX.
 *
 * <p>Se publica via {@code ApplicationEventPublisher} (no por el bus SSE)
 * porque es comunicación entre services del backend, no hacia el frontend.
 */
public record SyncCatalogoCompletadoEvent(int productosActualizados) {
}
