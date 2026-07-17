package ar.com.leo.showroom.cliente.entity;

import jakarta.persistence.*;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;

/**
 * Maestro editable de clientes. Sirve para que el operador pueda corregir o
 * completar datos (nombre/email/rubro/notas) sin tener que tocar los
 * presupuestos y pedidos históricos, que son snapshots inmutables.
 *
 * <p>La vista de /clientes hace LEFT JOIN lógico por {@link #telefonoNormalizado}:
 * si existe un master para ese cliente, sus campos pisan los datos derivados
 * del último movimiento; si no, se siguen mostrando los del último movimiento
 * como antes. Esto permite editar sin alterar el histórico (un PDF de un
 * presupuesto viejo sigue mostrando el nombre con el que se generó).
 *
 * <p>La PK lógica es el teléfono normalizado (solo dígitos) — usamos un id
 * auto-incremental como PK física por convención JPA + para no tener que
 * regenerar referencias si en el futuro hubiera que normalizar distinto.
 */
@Entity
@Table(name = "cliente_master", indexes = {
        @Index(name = "uk_cliente_master_telefono",
                columnList = "telefono_normalizado", unique = true),
        // Índice ÚNICO sobre el CUIT: el cliente formal se identifica unívocamente
        // por su documento. nro_doc es nullable y MySQL permite múltiples NULL en
        // un índice único, así que los clientes informales sin CUIT (presupuestos)
        // conviven sin chocar. El upsert reusa la fila del CUIT (no crea duplicados);
        // la edición manual valida contra colisión antes de guardar.
        @Index(name = "uk_cliente_master_nro_doc", columnList = "nro_doc", unique = true),
})
@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class ClienteMaster {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    /** Teléfono normalizado a solo dígitos — misma normalización que se usa
     *  para agrupar movimientos en {@code PresupuestoComercialService#claveTelefono}.
     *  Sin esto "11-12345678" y "1112345678" caerían en masters distintos. */
    @Column(name = "telefono_normalizado", length = 50, nullable = false, unique = true)
    private String telefonoNormalizado;

    /** Razón social / apellido del cliente — va a DUX como
     *  {@code apellido_razon_social} al crear un pedido. Distinto de
     *  {@link #nombre} (nombre de fantasía / contacto). */
    @Column(name = "razon_social", length = 150)
    private String razonSocial;

    @Column(name = "nombre", length = 150)
    private String nombre;

    @Column(name = "email", length = 150)
    private String email;

    /** Rubro comercial — puede ser uno de los predefinidos
     *  ('bar', 'restaurant', ...) o un texto libre cuando el operador eligió
     *  "Otros". Mismo modelo que el campo equivalente en presupuestos/pedidos. */
    @Column(name = "rubro", length = 100)
    private String rubro;

    /** Notas libres del operador — útiles como CRM ligero (preferencias del
     *  cliente, frecuencia de compra, contacto preferido, etc.). Sin límite
     *  estricto pero pensado para texto corto. */
    @Lob
    @Column(name = "notas", columnDefinition = "TEXT")
    private String notas;

    // ---- Datos de facturación y envío ----
    // CUIT/envío solo se guardan en los pedidos (los presupuestos no los tienen).
    // El maestro permite corregirlos/completarlos sin tocar el historial; si están
    // seteados pisan los datos derivados del último pedido al armar /clientes.

    /** Tipo de documento (DNI/CUIT/CUIL) — mismo dominio que el pedido. */
    @Column(name = "tipo_doc", length = 10)
    private String tipoDoc;

    /** Número de documento — Long para soportar CUIT/CUIL de 11 dígitos. */
    @Column(name = "nro_doc")
    private Long nroDoc;

    @Column(name = "domicilio", length = 200)
    private String domicilio;

    /** Código (cod_iso) de la provincia de envío — misma clave que usa el
     *  pedido y el endpoint /localidades. */
    @Column(name = "codigo_provincia", length = 10)
    private String codigoProvincia;

    /** Id de la localidad de envío (como String, igual que en el pedido). */
    @Column(name = "id_localidad", length = 20)
    private String idLocalidad;

    /** Operador que hizo la última edición — snapshot del username logueado.
     *  Nullable para tolerar inserts iniciales sin auth en tests. */
    @Column(name = "actualizado_por_usuario_id")
    private Long actualizadoPorUsuarioId;

    @Column(name = "actualizado_at", nullable = false)
    private Instant actualizadoAt;

    // ---- Actividad materializada (cache derivada de presupuestos + pedidos) ----
    // Estos campos NO los edita el operador: los recalcula
    // ClienteMasterService.recalcularActividad(telefono) cada vez que el cliente
    // tiene un movimiento nuevo (presupuesto/pedido creado, presupuesto borrado).
    // Se materializan para que la vista /clientes pueda paginar y ORDENAR en SQL
    // sin cruzar todos los movimientos en memoria en cada request. El recálculo
    // es idempotente (lee el estado real, no incrementa), así que un backfill
    // siempre los deja consistentes.

    /** Fecha del movimiento (presupuesto o pedido) más reciente del cliente.
     *  Es el orden por defecto del listado (cliente más reciente arriba). Null
     *  para clientes de alta manual sin movimientos. */
    @Column(name = "ultimo_movimiento_at")
    private Instant ultimoMovimientoAt;

    /** Fecha del movimiento más antiguo del cliente. */
    @Column(name = "primer_movimiento_at")
    private Instant primerMovimientoAt;

    /** Cantidad de presupuestos comerciales (no eliminados) del cliente. */
    @Column(name = "cantidad_presupuestos", nullable = false)
    @Builder.Default
    private int cantidadPresupuestos = 0;

    /** Cantidad de pedidos del cliente (incluye anulados — contador histórico). */
    @Column(name = "cantidad_pedidos", nullable = false)
    @Builder.Default
    private int cantidadPedidos = 0;

    /** Id del presupuesto más reciente — deep-link al historial. Null si el
     *  cliente solo tiene pedidos. */
    @Column(name = "ultimo_presupuesto_id")
    private Long ultimoPresupuestoId;

    /** Id del pedido más reciente — deep-link al listado de pedidos. Null si el
     *  cliente solo tiene presupuestos. */
    @Column(name = "ultimo_pedido_id")
    private Long ultimoPedidoId;

    /** Soft-delete: si está seteado, el cliente queda oculto del listado de
     *  /clientes aunque tenga historial. No se toca el historial — los
     *  presupuestos/pedidos previos siguen visibles en sus propias pantallas.
     *  Reactivar = setear a null (o editar el cliente, que limpia este flag). */
    @Column(name = "eliminado_at")
    private Instant eliminadoAt;
}
