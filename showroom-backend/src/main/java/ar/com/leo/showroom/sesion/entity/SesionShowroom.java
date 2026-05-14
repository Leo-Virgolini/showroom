package ar.com.leo.showroom.sesion.entity;

import jakarta.persistence.*;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.hibernate.annotations.BatchSize;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/**
 * Sesión de atención a un cliente en el showroom. Una sesión agrupa todos los
 * scans (productos vistos) entre que el operador clickea "Nuevo cliente" y
 * cierra el pedido (o abandona la sesión iniciando otra).
 *
 * <p>Distinta del {@code Carrito}: el carrito es lo que el cliente COMPRA;
 * la sesión es lo que el cliente VE. Al crear el pedido se genera un PDF con
 * los items vistos pero no comprados — "lista de interés" para follow-up.
 *
 * <p>Hay como máximo UNA sesión activa a la vez (igual que el carrito global).
 * "Activa" = {@code finalizadaAt IS NULL}. Iniciar una nueva sesión finaliza
 * la activa anterior si existía (sin pedido asociado → quedó abandonada).
 */
@Entity
@Table(name = "sesion_showroom", indexes = {
        @Index(name = "idx_sesion_showroom_iniciada_at", columnList = "iniciada_at"),
        @Index(name = "idx_sesion_showroom_finalizada_at", columnList = "finalizada_at"),
        @Index(name = "idx_sesion_showroom_pedido_id", columnList = "pedido_id")
})
@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class SesionShowroom {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    /** Nombre del cliente — lo carga el operador al clickear "Nuevo cliente". */
    @Column(name = "nombre", length = 150, nullable = false)
    private String nombre;

    @Column(name = "iniciada_at", nullable = false)
    private Instant iniciadaAt;

    /** Cuándo se cerró la sesión: NULL mientras está activa, timestamp cuando
     *  el operador cerró el pedido o inició una nueva (cerrando la anterior). */
    @Column(name = "finalizada_at")
    private Instant finalizadaAt;

    /** Pedido asociado a la sesión, si llegó a cerrarse uno. NULL para sesiones
     *  abandonadas. No es FK estricta (no usamos @ManyToOne para no inflar la
     *  fetch graph del listado) — la columna alcanza para hacer join manual. */
    @Column(name = "pedido_id")
    private Long pedidoId;

    @OneToMany(mappedBy = "sesion", cascade = CascadeType.ALL, orphanRemoval = true,
            fetch = FetchType.LAZY)
    @BatchSize(size = 50)
    @Builder.Default
    private List<SesionScanItem> items = new ArrayList<>();
}
