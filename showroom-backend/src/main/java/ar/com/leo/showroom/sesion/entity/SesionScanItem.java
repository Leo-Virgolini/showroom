package ar.com.leo.showroom.sesion.entity;

import jakarta.persistence.*;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;
import lombok.ToString;

import java.math.BigDecimal;
import java.time.Instant;

/**
 * Cada producto escaneado durante una sesión queda registrado acá. Restricción
 * {@code UNIQUE(sesion_id, sku)} → un mismo SKU solo se persiste una vez por
 * sesión; si el operador re-escanea, el service actualiza {@code escaneadoAt}
 * (no inserta duplicado).
 *
 * <p>Se guardan snapshots de descripción, precio e imagen al momento del scan:
 * si después DUX actualiza el catálogo, el PDF del historial muestra lo que
 * vio el cliente entonces, no la versión actual.
 */
@Entity
@Table(name = "sesion_scan_item",
        uniqueConstraints = @UniqueConstraint(name = "uk_sesion_scan_sku", columnNames = {"sesion_id", "sku"}),
        indexes = @Index(name = "idx_sesion_scan_sesion_id", columnList = "sesion_id"))
@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
@ToString(exclude = "sesion")  // evita loops infinitos con @Data
public class SesionScanItem {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "sesion_id", nullable = false)
    @com.fasterxml.jackson.annotation.JsonIgnore
    private SesionShowroom sesion;

    @Column(name = "sku", length = 50, nullable = false)
    private String sku;

    /** Descripción al momento del scan (snapshot). */
    @Column(name = "descripcion", length = 300)
    private String descripcion;

    /** Rubro DUX al momento del scan (ej. "MAQUINAS INDUSTRIALES"). Snapshot —
     *  si DUX recategoriza después, el PDF de ítems de interés sigue tratando
     *  el producto según lo que era cuando el cliente lo vio. */
    @Column(name = "rubro", length = 120)
    private String rubro;

    /** Precio con IVA al momento del scan. Si DUX lo cambió después, el PDF
     *  muestra este valor — refleja lo que vio el cliente. */
    @Column(name = "precio_con_iva", precision = 18, scale = 2)
    private BigDecimal precioConIva;

    /** % de IVA al momento del scan. Permite recalcular sin-IVA en el PDF. */
    @Column(name = "porc_iva", precision = 5, scale = 2)
    private BigDecimal porcIva;

    @Column(name = "escaneado_at", nullable = false)
    private Instant escaneadoAt;
}
