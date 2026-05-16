package ar.com.leo.showroom.sesion.repository;

import ar.com.leo.showroom.sesion.entity.SesionShowroom;
import ar.com.leo.showroom.showroom.dto.EstadisticaProductoDTO;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.EntityGraph;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.util.List;
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

    /** Top productos más escaneados — los que más interés despertaron entre los
     *  clientes, sin importar si terminaron en pedido. Agrupado por SKU; la
     *  descripción puede variar entre rows (snapshot al momento del scan), así
     *  que tomamos {@code MAX} arbitrariamente. {@code Pageable} permite limitar
     *  a top-N desde el caller. */
    @Query("""
            SELECT new ar.com.leo.showroom.showroom.dto.EstadisticaProductoDTO(
                i.sku, MAX(i.descripcion), COUNT(i))
            FROM SesionScanItem i
            WHERE (:desde IS NULL OR i.escaneadoAt >= :desde)
              AND (:hasta IS NULL OR i.escaneadoAt <= :hasta)
            GROUP BY i.sku
            ORDER BY COUNT(i) DESC, i.sku ASC
            """)
    List<EstadisticaProductoDTO> topEscaneados(
            @Param("desde") Instant desde,
            @Param("hasta") Instant hasta,
            Pageable pageable);

    /** Cuenta TODOS los SKUs escaneados sin límite, para joinear con los
     *  comprados y calcular la conversión por producto. Sin {@code Pageable}
     *  porque queremos el universo completo (el filtro / orden lo hace el
     *  caller en Java). */
    @Query("""
            SELECT new ar.com.leo.showroom.showroom.dto.EstadisticaProductoDTO(
                i.sku, MAX(i.descripcion), COUNT(i))
            FROM SesionScanItem i
            WHERE (:desde IS NULL OR i.escaneadoAt >= :desde)
              AND (:hasta IS NULL OR i.escaneadoAt <= :hasta)
            GROUP BY i.sku
            """)
    List<EstadisticaProductoDTO> contarEscaneadosPorSku(
            @Param("desde") Instant desde,
            @Param("hasta") Instant hasta);

    /** Cuenta sesiones cerradas en el rango. Una "sesión finalizada" es la que
     *  el operador cerró explícitamente (con o sin pedido) — es el denominador
     *  natural del KPI de conversión. */
    @Query("""
            SELECT COUNT(s) FROM SesionShowroom s
            WHERE s.finalizadaAt IS NOT NULL
              AND (:desde IS NULL OR s.iniciadaAt >= :desde)
              AND (:hasta IS NULL OR s.iniciadaAt <= :hasta)
            """)
    long contarFinalizadas(
            @Param("desde") Instant desde,
            @Param("hasta") Instant hasta);

    /** Sesiones cuyo pedido NO está anulado. Numerador del KPI de conversión.
     *  Subselect para filtrar por estado del pedido sin tener que mapear FK
     *  explícita ({@code pedidoId} es Long opaco en la entity). */
    @Query("""
            SELECT COUNT(s) FROM SesionShowroom s
            WHERE s.finalizadaAt IS NOT NULL
              AND s.pedidoId IS NOT NULL
              AND s.pedidoId IN (
                  SELECT p.id FROM PedidoShowroom p
                  WHERE p.estado <> ar.com.leo.showroom.pedido.entity.EstadoPedido.ANULADO
              )
              AND (:desde IS NULL OR s.iniciadaAt >= :desde)
              AND (:hasta IS NULL OR s.iniciadaAt <= :hasta)
            """)
    long contarConPedido(
            @Param("desde") Instant desde,
            @Param("hasta") Instant hasta);
}
