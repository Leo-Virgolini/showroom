package ar.com.leo.showroom.cliente.event;

/**
 * Evento de dominio: un cliente tuvo un movimiento que cambia su actividad
 * (se creó/editó un presupuesto, se creó un pedido, se borró un presupuesto).
 *
 * <p>Lo publican los flujos dentro de su transacción y lo consume
 * {@code ClienteMasterService} en fase {@code AFTER_COMMIT} para recalcular la
 * actividad materializada del cliente en una transacción nueva. Hacerlo
 * post-commit garantiza que el recálculo VEA el movimiento recién guardado y el
 * master (creado en una transacción {@code REQUIRES_NEW} aparte), evitando el
 * problema de visibilidad bajo aislamiento REPEATABLE READ; además desacopla el
 * costo del recálculo de la transacción principal del movimiento.
 *
 * @param telefonoNormalizado teléfono (solo dígitos) que identifica al cliente.
 */
public record ClienteMovimientoEvent(String telefonoNormalizado) {
}
