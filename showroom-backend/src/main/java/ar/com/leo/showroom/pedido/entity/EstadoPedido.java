package ar.com.leo.showroom.pedido.entity;

/**
 * Estado de ciclo de vida de un pedido en el showroom (espejo del tipo TS en
 * `models.ts` del frontend — `'ENVIADO' | 'PENDIENTE' | 'ERROR'`).
 */
public enum EstadoPedido {
    /** Pedido guardado localmente, todavía no se intentó mandar a DUX. */
    PENDIENTE,
    /** Pedido aceptado por DUX. */
    ENVIADO,
    /** DUX rechazó el payload — el pedido queda local con la respuesta de DUX en `respuesta_dux`. */
    ERROR
}
