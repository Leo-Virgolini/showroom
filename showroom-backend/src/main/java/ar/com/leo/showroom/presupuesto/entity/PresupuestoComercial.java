package ar.com.leo.showroom.presupuesto.entity;

import jakarta.persistence.*;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.math.BigDecimal;
import java.time.Instant;

/**
 * Presupuesto comercial generado desde la pantalla /presupuestos. NO se manda
 * a DUX — es un PDF que se le envía al cliente por email con los items que
 * eligió cotizar, cada uno con su descuento individual.
 *
 * <p>El {@code id} auto-incremental es el "número de presupuesto" que aparece
 * en el header del PDF. Los items + totales + formas de pago se serializan a
 * JSON en {@link #itemsJson} y {@link #formasPagoJson} para no abrir N tablas
 * extras — el detalle se rehidrata en memoria al regenerar el PDF.
 */
@Entity
@Table(name = "presupuesto_comercial", indexes = {
        @Index(name = "idx_presupuesto_comercial_creado_at", columnList = "creado_at"),
        @Index(name = "idx_presupuesto_comercial_usuario_id", columnList = "usuario_id"),
})
@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class PresupuestoComercial {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    /** Operador que generó el presupuesto — snapshot del usuario logueado al
     *  POST /presupuesto-comercial/{preview|enviar}. Nullable para no romper
     *  presupuestos legacy generados antes del multi-usuario. Lo usa el envío
     *  async para que el toast del email aparezca solo en SU pantalla. */
    @Column(name = "usuario_id")
    private Long usuarioId;

    @Column(name = "creado_at", nullable = false)
    private Instant creadoAt;

    /** Timestamp de la última edición — null mientras el presupuesto no se
     *  haya tocado desde que se generó. Se setea al ejecutar PUT
     *  {@code /presupuesto-comercial/{id}}. El historial muestra esta fecha
     *  como pill secundario cuando está presente, para que el operador note
     *  que el PDF no coincide con el original. */
    @Column(name = "modificado_at")
    private Instant modificadoAt;

    @Column(name = "cliente_nombre", length = 150)
    private String clienteNombre;

    @Column(name = "cliente_telefono", length = 50)
    private String clienteTelefono;

    @Column(name = "cliente_email", length = 150)
    private String clienteEmail;

    /** Rubro comercial del cliente (bar, restaurant, panadería, etc.) o un
     *  texto libre cuando el operador eligió "Otros". Lo usa el equipo
     *  comercial para segmentar y armar campañas dirigidas. Opcional —
     *  null cuando no se completó. */
    @Column(name = "rubro", length = 100)
    private String rubro;

    /** Total final sin IVA — suma de cada línea con su descuento individual
     *  aplicado. Es lo que se muestra en el listado del historial. */
    @Column(name = "subtotal_sin_iva", precision = 18, scale = 2)
    private BigDecimal subtotalSinIva;

    /** % EFECTIVO del descuento sobre el subtotal bruto, calculado en el
     *  frontend al momento de generar el presupuesto. Solo informativo:
     *  los items en {@link #itemsJson} ya traen sus descuentos individuales
     *  aplicados, NO se reaplica ningún factor encima (ver feedback del
     *  2026-05-20). 0 cuando no hubo descuentos. */
    @Column(name = "descuento_global_porcentaje", precision = 5, scale = 2)
    private BigDecimal descuentoGlobalPorcentaje;

    /** Items del presupuesto serializados como JSON (sku, descripcion, cantidad,
     *  precioConIva, porcIva, descuentoPorcentaje, imagenSku). */
    @Lob
    @Column(name = "items_json", columnDefinition = "TEXT", nullable = false)
    private String itemsJson;

    /** Formas de pago snapshot (id, nombre, recargoPorcentaje, cantidadCuotas,
     *  aplicaIva, precioFinal) — congeladas al momento de generar el presupuesto.
     *  Permite regenerar el PDF idéntico aunque cambien las formas activas. */
    @Lob
    @Column(name = "formas_pago_json", columnDefinition = "TEXT")
    private String formasPagoJson;

    /** Observaciones libres que se imprimen debajo del detalle. */
    @Column(name = "observaciones", length = 500)
    private String observaciones;

    /** Timestamp de eliminación lógica (soft-delete). Cuando es null el
     *  presupuesto es visible en el historial; cuando tiene valor, queda
     *  oculto pero el registro físicamente persiste — permite recuperar
     *  desde la DB si el operador borra por error. */
    @Column(name = "eliminado_at")
    private Instant eliminadoAt;

    /** Id del pedido DUX creado a partir de este presupuesto, si el operador
     *  lo transformó (botón "Crear pedido" del historial). Null = todavía no
     *  se generó. El historial muestra el pill "→ Pedido #N" cuando hay
     *  valor — sirve para rastreabilidad y para evitar duplicar la creación
     *  del pedido al volver al historial después. */
    @Column(name = "convertido_en_pedido_id")
    private Long convertidoEnPedidoId;

    /** Cuándo se (re)generó el pedido a partir de este presupuesto. Null si
     *  nunca se convirtió. Permite detectar que el presupuesto se editó DESPUÉS
     *  de generar el pedido (modificadoAt posterior a convertidoAt) y ofrecer
     *  "Regenerar pedido". Se actualiza en cada (re)vinculación. */
    @Column(name = "convertido_at")
    private Instant convertidoAt;
}
