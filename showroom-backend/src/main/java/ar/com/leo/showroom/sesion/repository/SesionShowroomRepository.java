package ar.com.leo.showroom.sesion.repository;

import ar.com.leo.showroom.sesion.entity.SesionShowroom;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.EntityGraph;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.util.Optional;

@Repository
public interface SesionShowroomRepository extends JpaRepository<SesionShowroom, Long> {

    /** La sesión actualmente activa (sin finalizar). Hay como máximo una a la
     *  vez por diseño — si por algún motivo hubiera más de una con finalizadaAt
     *  null (corte abrupto del backend mid-iniciar) devolvemos la más reciente. */
    @Query("""
            SELECT s FROM SesionShowroom s
            WHERE s.finalizadaAt IS NULL
            ORDER BY s.iniciadaAt DESC
            """)
    Optional<SesionShowroom> findActiva();

    /** Detalle de una sesión con sus items hidratados (evita N+1 al renderizar). */
    @EntityGraph(attributePaths = "items")
    @Query("SELECT s FROM SesionShowroom s WHERE s.id = :id")
    Optional<SesionShowroom> findByIdWithItems(@Param("id") Long id);

    /** Sesión asociada a un pedido (post-finalización). Con items hidratados
     *  para que el email service pueda generar el PDF fuera del @Transactional. */
    @EntityGraph(attributePaths = "items")
    @Query("SELECT s FROM SesionShowroom s WHERE s.pedidoId = :pedidoId")
    Optional<SesionShowroom> findByPedidoIdWithItems(@Param("pedidoId") Long pedidoId);

    /** Listado paginado de sesiones con filtros opcionales. Búsqueda LIKE
     *  case-insensitive sobre el nombre del cliente. Rango de fechas optativo. */
    @Query("""
            SELECT s FROM SesionShowroom s
            WHERE (:q IS NULL OR LOWER(s.nombre) LIKE LOWER(CONCAT('%', :q, '%')))
              AND (:desde IS NULL OR s.iniciadaAt >= :desde)
              AND (:hasta IS NULL OR s.iniciadaAt <= :hasta)
            """)
    Page<SesionShowroom> buscar(
            @Param("q") String q,
            @Param("desde") Instant desde,
            @Param("hasta") Instant hasta,
            Pageable pageable);
}
