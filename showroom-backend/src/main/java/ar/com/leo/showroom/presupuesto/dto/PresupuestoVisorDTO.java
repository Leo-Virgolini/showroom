package ar.com.leo.showroom.presupuesto.dto;

import java.math.BigDecimal;
import java.util.List;

/**
 * Snapshot del armado de un presupuesto para mostrarlo en el visor read-only
 * del celular (pantalla {@code /visor-presupuesto/{username}}).
 *
 * <p>Lo construye el frontend ({@code presupuestos-page}) ante cada cambio y lo
 * publica vía {@code POST /visor/presupuesto}; el backend solo lo guarda en
 * memoria y lo reemite por SSE ({@code presupuesto-visor}). Es un DTO de
 * entrada/salida — no se persiste en BD.
 *
 * <p>Los campos opcionales son wrappers con default en el compact constructor:
 * Jackson tiene {@code FAIL_ON_NULL_FOR_PRIMITIVES=true}, así que un primitivo
 * faltante en el JSON rompería la deserialización.
 */
public record PresupuestoVisorDTO(
        /** Nombre del cliente del presupuesto. Null/blank ⇒ el visor muestra
         *  el encabezado genérico "Presupuesto" (estado válido, no error). */
        String clienteNombre,
        List<ItemVisor> items,
        /** Total efectivo (con la forma de pago de referencia y los descuentos
         *  individuales ya aplicados). */
        BigDecimal total,
        /** Todas las formas de pago calculadas, en el mismo orden que el footer
         *  del armado (la "mejor" primero, marcada con {@code esMejorPrecio}). */
        List<FormaPagoVisor> formasPago
) {
    public PresupuestoVisorDTO {
        if (items == null) items = List.of();
        if (formasPago == null) formasPago = List.of();
        if (total == null) total = BigDecimal.ZERO;
    }

    /** Snapshot vacío — visor en estado "esperando…" / hidratación sin datos. */
    public static PresupuestoVisorDTO vacio() {
        return new PresupuestoVisorDTO(null, List.of(), BigDecimal.ZERO, List.of());
    }

    /** Una línea del presupuesto tal como la ve el cliente. */
    public record ItemVisor(
            String sku,
            String descripcion,
            String imagenUrl,
            Integer cantidad,
            /** Precio de referencia unitario (forma destacada según el rubro). */
            BigDecimal precioUnitario,
            /** {@code precioUnitario * (1 - descuento) * cantidad}. */
            BigDecimal subtotalLinea
    ) {
        public ItemVisor {
            if (cantidad == null) cantidad = 0;
            if (precioUnitario == null) precioUnitario = BigDecimal.ZERO;
            if (subtotalLinea == null) subtotalLinea = BigDecimal.ZERO;
        }
    }

    /** Una forma de pago con su precio final ya calculado sobre el total. */
    public record FormaPagoVisor(
            Long id,
            String nombre,
            BigDecimal precioFinal,
            /** Cuotas de la forma (para el desglose "N cuotas de $X"); 1/null = contado. */
            Integer cantidadCuotas,
            /** True para la forma más barata (resaltada en el visor). */
            Boolean esMejorPrecio
    ) {
        public FormaPagoVisor {
            if (esMejorPrecio == null) esMejorPrecio = false;
        }
    }
}
