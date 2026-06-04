package ar.com.leo.showroom.cotizacion.entity;

import jakarta.persistence.*;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.math.BigDecimal;
import java.time.Instant;

/**
 * Cotización de financiación rápida — sin productos, solo un monto base
 * (sin IVA) y la lista de formas de pago disponibles con sus precios
 * calculados.
 *
 * <p>Caso de uso: el cliente pregunta "¿cuánto sale algo de $X en cuotas?".
 * El operador ingresa el monto, opcionalmente carga datos del cliente, y
 * genera un PDF con todas las formas activas (efectivo, transferencia,
 * cuotas) ya con sus totales.
 *
 * <p>Es un flujo paralelo y mucho más liviano que el presupuestador (no
 * tiene items, descuentos individuales, ni cotización por producto).
 */
@Entity
@Table(name = "cotizacion_financiera", indexes = {
        @Index(name = "idx_cotizacion_financiera_creado_at", columnList = "creado_at"),
        @Index(name = "idx_cotizacion_financiera_usuario_id", columnList = "usuario_id"),
})
@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class CotizacionFinanciera {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    /** Operador que generó la cotización — snapshot del usuario logueado.
     *  Nullable por compatibilidad con cotizaciones legacy si las hubiera.
     *  Se usa para que el SSE del email solo aparezca en SU pantalla. */
    @Column(name = "usuario_id")
    private Long usuarioId;

    @Column(name = "creado_at", nullable = false)
    private Instant creadoAt;

    /** Última edición — null mientras no se haya editado. Se setea con cada
     *  PUT {@code /cotizacion-financiera/{id}}. */
    @Column(name = "modificado_at")
    private Instant modificadoAt;

    @Column(name = "cliente_nombre", length = 150)
    private String clienteNombre;

    @Column(name = "cliente_telefono", length = 50)
    private String clienteTelefono;

    @Column(name = "cliente_email", length = 150)
    private String clienteEmail;

    /** Rubro comercial — string libre. Mismas opciones que el presupuesto
     *  comercial, validadas en el frontend. */
    @Column(name = "rubro", length = 100)
    private String rubro;

    /** Monto base CON IVA — el operador lo ingresa así (igual que en
     *  scan/presupuesto). El cotizador deriva el neto cuando lo necesita:
     *  {@code monto / (1 + IVA/100)}.
     *
     *  <p>Puede ser null/cero cuando la cotización usa SOLO el segundo monto
     *  ({@link #montoBaseConIva2}). El service valida que al menos uno de
     *  los dos sea > 0.
     *
     *  <p>NOTA columna histórica: la columna se sigue llamando
     *  {@code monto_base_sin_iva} para no migrar el schema, pero ahora
     *  guarda el monto CON IVA. Cotizaciones generadas ANTES de este cambio
     *  guardaron el neto (sin IVA) — diferencia aceptada. */
    @Column(name = "monto_base_sin_iva", precision = 18, scale = 2)
    private BigDecimal montoBaseConIva;

    /** % de IVA usado para el cálculo de las formas que aplican IVA. Por
     *  default 21 (la tasa general en Argentina). Lo guardamos por si en el
     *  futuro alguien necesita cotizar con otra tasa (10.5 productos
     *  esenciales, 27 servicios, etc.). */
    @Column(name = "porc_iva", precision = 5, scale = 2, nullable = false)
    private BigDecimal porcIva;

    /** Segundo monto base CON IVA, opcional. Permite cotizar simultáneamente
     *  dos productos con IVAs distintos (ej. una máquina con 21% y un insumo
     *  con 10.5%); las formas de pago se calculan sobre la suma respetando
     *  el IVA propio de cada monto. Null cuando solo se usa el monto
     *  principal.
     *
     *  <p>NOTA columna histórica: la columna {@code monto_base_sin_iva_2}
     *  ahora guarda el monto CON IVA (ver {@link #montoBaseConIva}). */
    @Column(name = "monto_base_sin_iva_2", precision = 18, scale = 2)
    private BigDecimal montoBaseConIva2;

    /** % de IVA para {@link #montoBaseConIva2}. Default 10.5 (productos
     *  esenciales). Null cuando no se usa el segundo monto. */
    @Column(name = "porc_iva_2", precision = 5, scale = 2)
    private BigDecimal porcIva2;

    /** Formas de pago snapshot (id, nombre, recargoPorcentaje, cantidadCuotas,
     *  aplicaIva, precioFinal). Congeladas al momento de generar la cotización
     *  para que regenerar el PDF dé el mismo resultado aunque cambien las
     *  formas activas. */
    @Lob
    @Column(name = "formas_pago_json", columnDefinition = "TEXT", nullable = false)
    private String formasPagoJson;

    /** Observaciones libres que se imprimen al final del PDF. */
    @Column(name = "observaciones", length = 500)
    private String observaciones;

    /** Timestamp de eliminación lógica — null = visible en el historial. */
    @Column(name = "eliminado_at")
    private Instant eliminadoAt;
}
