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
        @Index(name = "idx_pedido_showroom_estado", columnList = "estado"),
        @Index(name = "idx_pedido_showroom_usuario_id", columnList = "usuario_id")
})
@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class PedidoShowroom {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    /** Operador que creó el pedido — snapshot del id del usuario logueado al
     *  POST /pedido-dux. Nullable para no romper pedidos legacy creados antes
     *  del multi-usuario. Útil para: filtrar listados por operador, asociar
     *  notificaciones async (toast del email/whatsapp post-envío) al canal
     *  SSE personal del operador, y auditoría. */
    @Column(name = "usuario_id")
    private Long usuarioId;

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

    /** Total que pagó el cliente. Tiene IVA si {@code formaPagoAplicaIva} es
     *  true/null (caso normal: precio del cliente y comprobante DUX coinciden);
     *  está sin IVA si la forma "no aplica IVA" (el cliente paga sin IVA y el
     *  operador absorbe el IVA que igual se factura en DUX). */
    @Column(name = "total", precision = 18, scale = 2)
    private BigDecimal total;

    /** Total sin IVA del pedido (recargo aplicado, IVA descontado). Coincide
     *  con {@code total} cuando la forma no aplica IVA. Se computa al crear el
     *  pedido sumando precio_sin_iva × cantidad por cada item. */
    @Column(name = "total_sin_iva", precision = 18, scale = 2)
    private BigDecimal totalSinIva;

    /** % de descuento aplicado al pedido entero (según escala configurada
     *  en {@code escala_descuento}). Soporta decimales (ej: 5.50). */
    @Column(name = "descuento_porcentaje", precision = 5, scale = 2)
    private BigDecimal descuentoPorcentaje;

    /** Forma de pago elegida (FK opcional a {@code forma_pago.id} — sin
     *  constraint para no atar el pedido al ciclo de vida de la forma de
     *  pago). Si se desactiva o borra una forma_pago, el pedido conserva
     *  los snapshots de nombre/recargo/cuotas para auditoría. */
    @Column(name = "forma_pago_id")
    private Long formaPagoId;

    /** Snapshot del nombre de la forma de pago al momento del pedido. */
    @Column(name = "forma_pago_nombre", length = 100)
    private String formaPagoNombre;

    /** Snapshot del recargo % aplicado. Null si no se eligió forma de pago
     *  con recargo (efectivo, débito 1 cuota, etc.). */
    @Column(name = "recargo_porcentaje", precision = 6, scale = 2)
    private BigDecimal recargoPorcentaje;

    /** Snapshot de la cantidad de cuotas — informativo para PDF/UI. */
    @Column(name = "cantidad_cuotas")
    private Integer cantidadCuotas;

    /** Snapshot del flag {@code aplicaIva} de la forma de pago al momento del
     *  pedido. {@code true} (caso normal): el cliente pagó precio con IVA.
     *  {@code false}: el cliente pagó precio sin IVA — DUX igual recibió el
     *  comprobante con IVA y el operador absorbió la diferencia. Null en
     *  pedidos sin forma de pago. */
    @Column(name = "forma_pago_aplica_iva")
    private Boolean formaPagoAplicaIva;

    /** Total CON IVA antes de aplicar el recargo de financiación. Permite
     *  desglosar en la UI/PDF "subtotal vs total con financiación". Null en
     *  pedidos viejos sin forma de pago elegida (o equivalente al {@code total}). */
    @Column(name = "total_sin_recargo", precision = 18, scale = 2)
    private BigDecimal totalSinRecargo;

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
     * Nombre del cliente real para mostrar en PDF, email y nombre de archivo.
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
