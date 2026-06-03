package ar.com.leo.showroom.config.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Index;
import jakarta.persistence.Table;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.math.BigDecimal;
import java.time.Instant;

/**
 * Forma de pago que el operador puede ofrecer al cliente al armar un pedido.
 * Cada forma tiene un porcentaje de recargo (típicamente para financiación)
 * que se aplica al total del carrito — los precios unitarios que viajan a DUX
 * ya van con el recargo incorporado, así DUX trata el pedido como una venta
 * normal a esos precios.
 *
 * <p>Ejemplos típicos:
 * <ul>
 *   <li>Efectivo / 1 cuota / 0%</li>
 *   <li>Tarjeta débito / 1 cuota / 0%</li>
 *   <li>Crédito 3 cuotas / 3 / 15%</li>
 *   <li>Crédito 6 cuotas / 6 / 30%</li>
 * </ul>
 *
 * <p>{@code activo} permite "soft delete": el operador puede deshabilitar una
 * forma sin perder los pedidos históricos que la referenciaron. Los pedidos
 * snapshotean nombre + recargo en {@code pedido_showroom} así sobreviven
 * tanto al desactivado como a un eventual hard delete.
 */
@Entity
@Table(name = "forma_pago", indexes = {
        @Index(name = "uk_forma_pago_nombre", columnList = "nombre", unique = true),
        @Index(name = "idx_forma_pago_activo_orden", columnList = "activo, orden")
})
@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class FormaPago {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "nombre", nullable = false, length = 100)
    private String nombre;

    /** Porcentaje de recargo aplicado al carrito completo. Ej: 30.00 = 30%.
     *  Se permite 0 (cuando no hay financiación). */
    @Column(name = "recargo_porcentaje", nullable = false, precision = 6, scale = 2)
    private BigDecimal recargoPorcentaje;

    /** Cantidad de cuotas — informativo para mostrar al operador y al cliente.
     *  No afecta el cálculo (el recargo es total, no por cuota). */
    @Column(name = "cantidad_cuotas", nullable = false)
    private Integer cantidadCuotas;

    /** Si {@code true}, el precio que paga el cliente incluye IVA (caso normal:
     *  transferencia con IVA, todas las cuotas, etc.). Si {@code false}, el
     *  cliente paga el precio sin IVA — DUX factura igual con IVA y el operador
     *  absorbe esa diferencia. Útil para "transferencia sin IVA" o ventas sin
     *  factura.
     *
     *  <p>Fórmula: {@code precio_final = precio_efectivo / (1 - recargo/100)
     *  × (aplicaIva ? (1 + iva/100) : 1)}.
     *
     *  <p>Default {@code true}: si la fila ya existía pre-migración o el
     *  operador no tildó el campo al crearla, asumimos comportamiento estándar. */
    @Column(name = "aplica_iva", nullable = false)
    private Boolean aplicaIva;

    /** Si false, no aparece en el selector del operador. Pedidos históricos
     *  que la referencian preservan sus datos via snapshot. */
    @Column(name = "activo", nullable = false)
    private Boolean activo;

    /** Orden manual en el dropdown del operador (asc). Default 0. */
    @Column(name = "orden", nullable = false)
    private Integer orden;

    /** Si {@code true}, la forma se muestra como "precio de referencia" en el
     *  panel de scan, el visor y el carrito (precio unitario por ítem). El
     *  orden ({@link #orden}) define cuál es la primera/destacada. Default
     *  {@code false}: las formas existentes no se muestran como referencia hasta
     *  que el operador las marque. Filas viejas con NULL se tratan como false en
     *  lectura. */
    @Column(name = "precio_referencia", nullable = false)
    private Boolean precioReferencia;

    @Column(name = "creado_at", nullable = false)
    private Instant creadoAt;
}
