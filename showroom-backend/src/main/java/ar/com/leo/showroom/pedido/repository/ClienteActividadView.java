package ar.com.leo.showroom.pedido.repository;

import java.math.BigDecimal;
import java.time.Instant;

/**
 * Proyección liviana de {@code PedidoShowroom} para armar la actividad de la
 * vista de clientes (/clientes): solo los campos escalares que consume el
 * agregador, sin hidratar la entidad completa ni su colección lazy de items.
 *
 * <p>Los nombres de los getters coinciden con los de la entidad a propósito,
 * para que el agregador los consuma indistintamente (entidad o proyección).
 */
public interface ClienteActividadView {
    String getTelefono();
    Instant getCreadoAt();
    Long getId();
    String getTipoDoc();
    Long getNroDoc();
    String getDomicilio();
    String getCodigoProvincia();
    String getIdLocalidad();
    String getEmail();
    String getNombre();
    String getRubro();
    BigDecimal getTotalSinIva();
}
