package ar.com.leo.showroom.pedido.entity;

import jakarta.persistence.*;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.hibernate.annotations.BatchSize;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

@Entity
@Table(name = "pedido_showroom", indexes = {
        @Index(name = "idx_pedido_showroom_nro_doc", columnList = "nro_doc"),
        @Index(name = "idx_pedido_showroom_creado_at", columnList = "creado_at"),
        @Index(name = "idx_pedido_showroom_estado", columnList = "estado")
})
@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class PedidoShowroom {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "creado_at", nullable = false)
    private Instant creadoAt;

    @Column(name = "enviado_at")
    private Instant enviadoAt;

    /** Cuándo se anuló el pedido (acción manual desde la pantalla de pedidos).
     *  Null mientras esté en cualquier otro estado. */
    @Column(name = "anulado_at")
    private Instant anuladoAt;

    /** Motivo libre que el operador puede tipear al anular. Opcional. */
    @Column(name = "motivo_anulacion", length = 500)
    private String motivoAnulacion;

    @Column(name = "respuesta_dux", columnDefinition = "TEXT")
    private String respuestaDux;

    @Enumerated(EnumType.STRING)
    @Column(name = "estado", length = 20, nullable = false)
    private EstadoPedido estado;

    @Column(name = "observaciones", length = 500)
    private String observaciones;

    /** Total CON IVA del pedido (precio × cantidad) — es el monto que va al comprobante DUX. */
    @Column(name = "total", precision = 18, scale = 2)
    private BigDecimal total;

    /** Total SIN IVA del pedido — lo que efectivamente paga el cliente en el showroom.
     *  Se computa al crear el pedido sumando precio_sin_iva × cantidad por cada item. */
    @Column(name = "total_sin_iva", precision = 18, scale = 2)
    private BigDecimal totalSinIva;

    /** % de descuento aplicado al pedido entero (0/5/10) según escala del total. */
    @Column(name = "descuento_porcentaje")
    private Integer descuentoPorcentaje;

    /** Datos del cliente del pedido — copiados del payload al crear. */
    @Column(name = "apellido_razon_social", length = 100)
    private String apellidoRazonSocial;

    /** Nombre y apellido (o razón social) real del cliente. Se manda a DUX en el
     *  campo `nombre` del payload de /pedido/nuevopedido. Opcional: si el operador
     *  no lo carga queda null y la columna Cliente del listado muestra "—".
     *  El campo `apellidoRazonSocial` se reserva para el placeholder fijo
     *  "PEDIDO SHOWROOM" que la operadora reemplaza en DUX al asociar el comprobante. */
    @Column(name = "nombre", length = 100)
    private String nombre;

    @Column(name = "tipo_doc", length = 10)
    private String tipoDoc;

    @Column(name = "nro_doc")
    private Long nroDoc;

    @Column(name = "telefono", length = 50)
    private String telefono;

    @Column(name = "email", length = 150)
    private String email;

    @Column(name = "domicilio", length = 200)
    private String domicilio;

    @Column(name = "codigo_provincia", length = 10)
    private String codigoProvincia;

    @Column(name = "id_localidad", length = 20)
    private String idLocalidad;

    /**
     * BatchSize=50 evita el N+1 al listar pedidos paginados: cuando el primer
     * pedido toca su collection (típicamente para `getItems().size()`), Hibernate
     * emite UN solo query `where pedido_id in (?, ?, ...)` que carga las items
     * de hasta 50 pedidos a la vez. Con page size=50 → 2 queries totales en vez de 51.
     */
    @OneToMany(mappedBy = "pedido", cascade = CascadeType.ALL, orphanRemoval = true)
    @BatchSize(size = 50)
    @Builder.Default
    private List<PedidoShowroomItem> items = new ArrayList<>();

    /**
     * Nombre del cliente real para mostrar en PDF, XLSX, email y nombre de archivo.
     * Prioriza `nombre` (donde el operador carga el nombre y apellido / razón
     * social real del cliente) y cae a `apellidoRazonSocial` solo si no hay
     * nombre — en pedidos del showroom ese fallback va a ser el placeholder
     * "PEDIDO SHOWROOM" que la operadora reemplaza al editar el comprobante en DUX.
     */
    public String getNombreCompleto() {
        if (nombre != null && !nombre.isBlank()) return nombre.trim();
        if (apellidoRazonSocial != null && !apellidoRazonSocial.isBlank()) return apellidoRazonSocial.trim();
        return null;
    }
}
