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
})
@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class PresupuestoComercial {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "creado_at", nullable = false)
    private Instant creadoAt;

    @Column(name = "cliente_nombre", length = 150)
    private String clienteNombre;

    @Column(name = "cliente_telefono", length = 50)
    private String clienteTelefono;

    @Column(name = "cliente_email", length = 150)
    private String clienteEmail;

    /** Subtotal sin IVA después de aplicar los descuentos individuales por
     *  línea (PRE descuento global). */
    @Column(name = "subtotal_sin_iva", precision = 18, scale = 2)
    private BigDecimal subtotalSinIva;

    /** IVA total (sumando cada línea con su porcIva propio, PRE descuento global). */
    @Column(name = "iva_total", precision = 18, scale = 2)
    private BigDecimal ivaTotal;

    /** Total con IVA (PRE descuento global). Base para los cálculos de las
     *  formas de pago que aplican IVA. */
    @Column(name = "total_con_iva", precision = 18, scale = 2)
    private BigDecimal totalConIva;

    /** % de descuento aplicado al subtotal entero (después de los descuentos
     *  individuales por ítem). 0 = sin descuento global. */
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
}
