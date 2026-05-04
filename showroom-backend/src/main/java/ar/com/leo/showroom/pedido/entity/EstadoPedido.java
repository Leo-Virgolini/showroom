package ar.com.leo.showroom.pedido.entity;

/**
 * Estado de ciclo de vida de un pedido en el showroom (espejo del tipo TS en
 * `models.ts` del frontend).
 */
public enum EstadoPedido {
    /** Pedido guardado localmente, todavía no se intentó mandar a DUX. */
    PENDIENTE,
    /** Pedido aceptado por DUX. */
    ENVIADO,
    /** DUX rechazó el payload — el pedido queda local con la respuesta de DUX en `respuesta_dux`. */
    ERROR,
    /** Pedido anulado por el operador (acción manual desde la pantalla de pedidos).
     *  Si el pedido había sido aceptado por DUX (estado ENVIADO previo), la anulación
     *  es solo local — en DUX hay que cancelar el comprobante a mano porque la API
     *  de DUX no expone esa operación. */
    ANULADO
}
