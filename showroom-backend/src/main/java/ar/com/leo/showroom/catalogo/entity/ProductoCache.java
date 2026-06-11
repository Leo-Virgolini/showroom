package ar.com.leo.showroom.catalogo.entity;

import jakarta.persistence.*;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.HashSet;
import java.util.Set;

@Entity
@Table(name = "producto_cache", indexes = {
        @Index(name = "idx_producto_cache_sku", columnList = "sku", unique = true),
        @Index(name = "idx_producto_cache_descripcion", columnList = "descripcion"),
        @Index(name = "idx_producto_cache_proveedor", columnList = "proveedor")
})
@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class ProductoCache {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false, length = 64, unique = true)
    private String sku;

    @Column(length = 200)
    private String descripcion;

    /** Nombre del rubro DUX (ej. "MAQUINAS INDUSTRIALES", "UTENSILIOS",
     *  "BAZAR"). Lo usamos para excluir ciertos rubros de los descuentos
     *  generales por escala (regla negocio: a MAQUINAS INDUSTRIALES no se le
     *  aplican los descuentos por monto). Null si DUX no informa rubro. */
    @Column(name = "rubro", length = 120)
    private String rubro;

    /** Nombre del proveedor del producto en DUX (ej. "SILCOOK SA"). Se usa para
     *  el filtro por proveedor en la búsqueda del showroom/presupuestador. Null
     *  si DUX no informa proveedor. */
    @Column(name = "proveedor", length = 150)
    private String proveedor;

    /** PVP de la lista "KT GASTRO" tal como viene de DUX (con IVA incluido). */
    @Column(name = "pvp_kt_gastro_con_iva", precision = 18, scale = 4)
    private BigDecimal pvpKtGastroConIva;

    /** % de IVA del producto en DUX (típicamente 21.00). */
    @Column(name = "porc_iva", precision = 6, scale = 2)
    private BigDecimal porcIva;

    /** Stock total disponible sumado de todos los depósitos. */
    @Column(name = "stock_total")
    private Integer stockTotal;

    @Column(name = "habilitado")
    private Boolean habilitado;

    /**
     * Códigos de barras (EAN-13 u otros) del producto. Persistidos en una tabla
     * lateral {@code producto_cache_codigo_barra} con índice sobre `ean`, para
     * que el lookup desde la pistola sea O(log N) — fundamental cuando el cache
     * tiene miles de productos. Hibernate gestiona inserts/updates/deletes
     * automáticamente al sincronizar el Set.
     */
    @ElementCollection(fetch = FetchType.LAZY)
    @CollectionTable(
            name = "producto_cache_codigo_barra",
            joinColumns = @JoinColumn(name = "producto_id"),
            indexes = @Index(name = "idx_pcb_ean", columnList = "ean")
    )
    @Column(name = "ean", length = 32, nullable = false)
    @Builder.Default
    private Set<String> codigosBarra = new HashSet<>();

    @Column(name = "sincronizado_at", nullable = false)
    private Instant sincronizadoAt;
}
