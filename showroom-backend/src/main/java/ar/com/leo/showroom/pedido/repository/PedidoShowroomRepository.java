package ar.com.leo.showroom.pedido.repository;

import ar.com.leo.showroom.pedido.entity.EstadoPedido;
import ar.com.leo.showroom.pedido.entity.PedidoShowroom;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.Instant;

public interface PedidoShowroomRepository extends JpaRepository<PedidoShowroom, Long> {

    Page<PedidoShowroom> findAllByOrderByCreadoAtDesc(Pageable pageable);

    /**
     * Búsqueda paginada con filtros para la pantalla de listado de pedidos.
     * `q` matchea como substring case-insensitive contra nro_doc (CUIT) o
     * apellido/razón social del cliente. El orden lo provee el {@link Pageable}
     * (Spring concatena el ORDER BY automáticamente) — así la tabla puede ordenar
     * por cualquier columna. El default lo decide el caller.
     */
    @Query("""
            select p from PedidoShowroom p
            where (:q is null or :q = ''
                   or cast(p.nroDoc as string) like concat('%', :q, '%')
                   or lower(p.apellidoRazonSocial) like concat('%', lower(:q), '%'))
              and (:estado is null or p.estado = :estado)
              and (:desde is null or p.creadoAt >= :desde)
              and (:hasta is null or p.creadoAt <= :hasta)
            """)
    Page<PedidoShowroom> buscar(
            @Param("q") String q,
            @Param("estado") EstadoPedido estado,
            @Param("desde") Instant desde,
            @Param("hasta") Instant hasta,
            Pageable pageable
    );
}
