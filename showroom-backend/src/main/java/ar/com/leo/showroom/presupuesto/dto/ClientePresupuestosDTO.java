package ar.com.leo.showroom.presupuesto.dto;

import java.math.BigDecimal;
import java.time.Instant;

/**
 * Resumen de un cliente reconstruido a partir de los presupuestos y pedidos
 * guardados. Sirve a la pantalla {@code /clientes} donde el operador ve la
 * lista de personas con las que tuvo movimientos comerciales sin tener que
 * entrar al detalle de cada uno.
 *
 * <p>Los clientes se identifican por teléfono normalizado (solo dígitos);
 * los movimientos sin teléfono no aparecen en esta vista. Si un mismo
 * cliente tiene varios presupuestos/pedidos con nombre/email distintos pero
 * el mismo teléfono, se toman los datos del movimiento más reciente como
 * canónicos (el operador puede haber tipeado mal en uno viejo).
 *
 * <p>El "movimiento más reciente" es el que tiene la fecha {@code creadoAt}
 * mayor entre presupuestos y pedidos combinados — eso define {@code nombre},
 * {@code email}, {@code rubro}, {@code ultimoMovimientoAt} y
 * {@code ultimoTotalSinIva}. {@code ultimoPresupuestoId} y
 * {@code ultimoPedidoId} se completan independientemente para que el
 * frontend pueda ofrecer "Ver presupuestos" y "Ver pedidos" como acciones
 * distintas.
 */
public record ClientePresupuestosDTO(
        String email,
        String telefono,
        String nombre,
        String rubro,
        /** Cantidad total de presupuestos comerciales generados para este
         *  teléfono. 0 si el cliente solo llegó vía pedidos. */
        int cantidadPresupuestos,
        /** Cantidad total de pedidos (incluye anulados — el contador es
         *  histórico). 0 si el cliente solo llegó vía presupuestos. */
        int cantidadPedidos,
        /** Fecha del movimiento más antiguo (presupuesto o pedido). */
        Instant primerMovimientoAt,
        /** Fecha del movimiento más reciente — define los datos "canónicos"
         *  (nombre, email, rubro) y el total mostrado en pantalla. */
        Instant ultimoMovimientoAt,
        /** Total sin IVA del último movimiento. Útil para ver de un vistazo
         *  cuánto fue la última operación con el cliente. */
        BigDecimal ultimoTotalSinIva,
        /** ID del presupuesto más reciente — sirve para el deep-link al
         *  historial filtrado por este cliente. Null si solo tiene pedidos. */
        Long ultimoPresupuestoId,
        /** ID del pedido más reciente — sirve para el deep-link al listado
         *  de pedidos filtrado por este cliente. Null si solo tiene presupuestos. */
        Long ultimoPedidoId,
        // ---- Datos de facturación y envío ----
        // Solo existen en pedidos: se toman del pedido más reciente del cliente
        // (no del movimiento canónico, que podría ser un presupuesto sin estos
        // datos). El master, si los tiene, los pisa.
        /** Tipo de documento (DNI/CUIT/CUIL) del último pedido. Null si el
         *  cliente solo tiene presupuestos. */
        String tipoDoc,
        /** Número de documento (CUIT/DNI) del último pedido. */
        Long nroDoc,
        String domicilio,
        /** Código (cod_iso) de la provincia de envío — clave para editar. */
        String codigoProvincia,
        /** Nombre de la provincia resuelto desde {@code codigoProvincia}.
         *  Null si no se pudo resolver. Para mostrar/ordenar en la tabla. */
        String provinciaNombre,
        /** Id de la localidad de envío — clave para editar. */
        String idLocalidad,
        /** Nombre de la localidad resuelto desde {@code idLocalidad}. */
        String localidadNombre,
        /** Razón social / apellido del cliente — viene del maestro editable
         *  ({@code ClienteMaster.razonSocial}); null para clientes que aún no la
         *  tienen cargada. Es lo que va a DUX como {@code apellido_razon_social}. */
        String razonSocial
) {
}
