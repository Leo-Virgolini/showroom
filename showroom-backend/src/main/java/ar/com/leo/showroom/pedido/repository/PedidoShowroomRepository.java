package ar.com.leo.showroom.pedido.repository;

import ar.com.leo.showroom.pedido.entity.EstadoPedido;
import ar.com.leo.showroom.pedido.entity.PedidoShowroom;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Optional;

public interface PedidoShowroomRepository extends JpaRepository<PedidoShowroom, Long> {

    Page<PedidoShowroom> findAllByOrderByCreadoAtDesc(Pageable pageable);

    /**
     * Carga el pedido junto con sus items en una sola query (JOIN FETCH).
     * Indispensable cuando vamos a pasar la entidad a un método {@code @Async}
     * que va a iterar los items — en otro thread la sesión Hibernate ya está
     * cerrada y un {@code findById} normal tira
     * {@code LazyInitializationException} al tocar {@code getItems()}.
     */
    @Query("select p from PedidoShowroom p left join fetch p.items where p.id = :id")
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

    /**
     * Búsqueda paginada con filtros para la pantalla de listado de pedidos.
     * `q` matchea como substring case-insensitive contra nro_doc (CUIT),
     * apellido_razon_social (placeholder fijo en pedidos del showroom) o
     * nombre y apellido / razón social real del cliente (`nombre`). El filtro
     * {@code id} permite el deep-link desde /historial — cuando viene presente,
     * la lista colapsa al pedido específico que el operador clickeó. El orden
     * lo provee el {@link Pageable} (Spring concatena el ORDER BY automáticamente)
     * — así la tabla puede ordenar por cualquier columna. El default lo decide el caller.
     */
    @Query("""
            select p from PedidoShowroom p
            where (:id is null or p.id = :id)
              and (:q is null or :q = ''
                   or cast(p.nroDoc as string) like concat('%', :q, '%')
                   or lower(p.apellidoRazonSocial) like concat('%', lower(:q), '%')
                   or lower(p.nombre) like concat('%', lower(:q), '%'))
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
}
