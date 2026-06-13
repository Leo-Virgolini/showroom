package ar.com.leo.showroom.pedido.repository;

import ar.com.leo.showroom.pedido.entity.EstadoPedido;
import ar.com.leo.showroom.pedido.entity.PedidoShowroom;
import ar.com.leo.showroom.showroom.dto.EstadisticaProductoDTO;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Optional;

public interface PedidoShowroomRepository extends JpaRepository<PedidoShowroom, Long> {

    Page<PedidoShowroom> findAllByOrderByCreadoAtDesc(Pageable pageable);

    // ---- Actividad por cliente (vista /clientes, materializada en ClienteMaster) ----

    /** Cantidad de pedidos de un cliente (incluye anulados — contador histórico). */
    long countByClienteTelefonoNormalizado(String clienteTelefonoNormalizado);

    /** Pedido más reciente del cliente — define el último monto/id y los datos
     *  de facturación/envío del cliente. */
    Optional<PedidoShowroom> findFirstByClienteTelefonoNormalizadoOrderByCreadoAtDesc(
            String clienteTelefonoNormalizado);

    /** Pedido más antiguo del cliente — candidato a primer movimiento. */
    Optional<PedidoShowroom> findFirstByClienteTelefonoNormalizadoOrderByCreadoAtAsc(
            String clienteTelefonoNormalizado);

    /** Teléfonos normalizados distintos presentes en pedidos — usado por el
     *  backfill para sembrar un master por cada cliente con historial. */
    @Query("select distinct p.clienteTelefonoNormalizado from PedidoShowroom p "
            + "where p.clienteTelefonoNormalizado is not null")
    List<String> telefonosNormalizadosDistintos();

    /** Backfill one-shot: deriva {@code cliente_telefono_normalizado} (solo
     *  dígitos) de {@code telefono} para las filas que aún no lo tienen.
     *  Idempotente: solo toca filas con al menos un dígito (el {@code <> ''}
     *  evita re-procesar en cada arranque los teléfonos no numéricos, que quedan
     *  NULL). Devuelve cuántas filas actualizó. */
    @Modifying
    @Query(value = "UPDATE pedido_showroom "
            + "SET cliente_telefono_normalizado = REGEXP_REPLACE(telefono, '[^0-9]', '') "
            + "WHERE cliente_telefono_normalizado IS NULL AND telefono IS NOT NULL "
            + "  AND REGEXP_REPLACE(telefono, '[^0-9]', '') <> ''",
            nativeQuery = true)
    int backfillTelefonoNormalizado();

    /** Último pedido con un CUIT/documento dado — fallback para autocompletar
     *  los datos del cliente al tipear el CUIT cuando no hay un maestro guardado. */
    Optional<PedidoShowroom> findFirstByNroDocOrderByCreadoAtDesc(Long nroDoc);

    /**
     * Carga el pedido junto con sus items en una sola query (JOIN FETCH).
     * Indispensable cuando vamos a pasar la entidad a un método {@code @Async}
     * que va a iterar los items — en otro thread la sesión Hibernate ya está
     * cerrada y un {@code findById} normal tira
     * {@code LazyInitializationException} al tocar {@code getItems()}.
     */
    @Query("select distinct p from PedidoShowroom p left join fetch p.items where p.id = :id")
    Optional<PedidoShowroom> findByIdWithItems(@Param("id") Long id);

    /** Estado del pedido por id, en bulk — usado por /historial para etiquetar
     *  las sesiones completadas cuyo pedido fue luego anulado. Una sola query
     *  para todos los ids de la página → evita N+1. */
    @Query("select p.id, p.estado from PedidoShowroom p where p.id in :ids")
    List<Object[]> findEstadosByIds(@Param("ids") Collection<Long> ids);

    /** SKUs incluidos en un pedido — usado por /historial para marcar qué items
     *  escaneados de la sesión terminaron efectivamente comprados. Solo SKUs,
     *  no se hidrata la entidad entera. */
    @Query("select i.sku from PedidoShowroomItem i where i.pedido.id = :pedidoId")
    List<String> findSkusByPedidoId(@Param("pedidoId") Long pedidoId);

    /** Cantidad de items por pedido, en bulk — usado por el listado paginado para
     *  evitar tocar la colección lazy {@code PedidoShowroom.items} (que requeriría
     *  OSIV o sufriría N+1). Una sola query agrupada por pedido_id. */
    @Query("select i.pedido.id, count(i) from PedidoShowroomItem i where i.pedido.id in :ids group by i.pedido.id")
    List<Object[]> contarItemsPorPedidoIds(@Param("ids") Collection<Long> ids);

    /**
     * Búsqueda paginada con filtros para la pantalla de listado de pedidos.
     * `q` matchea como substring case-insensitive contra nro_doc (CUIT),
     * apellido_razon_social (placeholder fijo en pedidos del showroom),
     * nombre y apellido / razón social real del cliente (`nombre`) y el
     * teléfono — este último habilita el deep-link "Ver pedidos" desde
     * /clientes, que filtra por un fragmento del teléfono. El filtro
     * {@code id} permite el deep-link desde /historial — cuando viene presente,
     * la lista colapsa al pedido específico que el operador clickeó. El orden
     * lo provee el {@link Pageable} (Spring concatena el ORDER BY automáticamente)
     * — así la tabla puede ordenar por cualquier columna. El default lo decide el caller.
     */
    @Query("""
            select p from PedidoShowroom p
            where (:id is null or p.id = :id)
              and (:q is null or :q = ''
                   or cast(p.id as string) like concat('%', :q, '%')
                   or cast(p.nroDoc as string) like concat('%', :q, '%')
                   or lower(p.apellidoRazonSocial) like concat('%', lower(:q), '%')
                   or lower(p.nombre) like concat('%', lower(:q), '%')
                   or lower(coalesce(p.telefono, '')) like concat('%', lower(:q), '%'))
              and (:estado is null or p.estado = :estado)
              and (:desde is null or p.creadoAt >= :desde)
              and (:hasta is null or p.creadoAt <= :hasta)
            """)
    Page<PedidoShowroom> buscar(
            @Param("id") Long id,
            @Param("q") String q,
            @Param("estado") EstadoPedido estado,
            @Param("desde") Instant desde,
            @Param("hasta") Instant hasta,
            Pageable pageable
    );

    /** Top productos más comprados — agrega por SKU y suma {@code cantidad}.
     *  Solo cuenta pedidos no anulados (= los que efectivamente se concretaron).
     *  La descripción puede variar entre rows del mismo SKU, tomamos {@code MAX}
     *  arbitrariamente. {@code Pageable} limita a top-N desde el caller. */
    @Query("""
            select new ar.com.leo.showroom.showroom.dto.EstadisticaProductoDTO(
                i.sku, MAX(i.descripcion), CAST(SUM(i.cantidad) AS long))
            from PedidoShowroomItem i
            where i.pedido.estado <> ar.com.leo.showroom.pedido.entity.EstadoPedido.ANULADO
              and (:desde is null or i.pedido.creadoAt >= :desde)
              and (:hasta is null or i.pedido.creadoAt <= :hasta)
            group by i.sku
            order by SUM(i.cantidad) desc, i.sku asc
            """)
    List<EstadisticaProductoDTO> topComprados(
            @Param("desde") Instant desde,
            @Param("hasta") Instant hasta,
            Pageable pageable);

}
