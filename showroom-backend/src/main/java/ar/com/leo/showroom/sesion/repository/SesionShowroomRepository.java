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
import java.util.Collection;
import java.util.List;
import java.util.Optional;

@Repository
public interface SesionShowroomRepository extends JpaRepository<SesionShowroom, Long> {

    /** La sesión actualmente activa de un operador (sin finalizar). Hay como
     *  máximo una por usuario a la vez por diseño — si por algún motivo hubiera
     *  más de una con finalizadaAt null (corte abrupto del backend mid-iniciar)
     *  devolvemos la más reciente. */
    @Query("""
            SELECT s FROM SesionShowroom s
            WHERE s.usuarioId = :usuarioId AND s.finalizadaAt IS NULL
            ORDER BY s.iniciadaAt DESC
            """)
    Optional<SesionShowroom> findActivaByUsuarioId(@Param("usuarioId") Long usuarioId);

    /** Sesión por su token de visor (activa o no). El caller decide qué hacer
     *  según finalizadaAt: activa → OK, finalizada → 410, ausente → 404. */
    Optional<SesionShowroom> findByVisorToken(String visorToken);

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
     *  case-insensitive sobre el nombre del cliente. Rango de fechas optativo.
     *
     *  <p>Muestra SOLO sesiones provenientes del showroom: las que tienen al
     *  menos un scan o un pedido asociado. El presupuestador escanea con
     *  {@code publicarVisor=false} (no registra scans en la sesión) y sus
     *  pedidos no se asocian a la sesión ({@code origenPresupuesto}), así que
     *  una sesión iniciada desde el presupuestador queda con 0 scans y sin
     *  pedido → no es una atención del showroom y se excluye del historial. */
    @Query("""
            SELECT s FROM SesionShowroom s
            WHERE (:q IS NULL OR LOWER(s.nombre) LIKE LOWER(CONCAT('%', :q, '%')))
              AND (:desde IS NULL OR s.iniciadaAt >= :desde)
              AND (:hasta IS NULL OR s.iniciadaAt <= :hasta)
              AND (s.items IS NOT EMPTY OR s.pedidoId IS NOT NULL)
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

    /** Cuenta SESIONES ÚNICAS que escanearon cada SKU en el rango — es el
     *  denominador correcto para una tasa de conversión por producto. Un
     *  cliente que escanea el mismo SKU 5 veces en su sesión cuenta como UNA
     *  visita al producto, no como 5 (sino el denominador se infla y la
     *  conversión queda artificialmente baja). {@code COUNT(DISTINCT i.sesion)}
     *  fuerza la deduplicación a nivel sesión. */
    @Query("""
            SELECT new ar.com.leo.showroom.showroom.dto.EstadisticaProductoDTO(
                i.sku, MAX(i.descripcion), COUNT(DISTINCT i.sesion))
            FROM SesionScanItem i
            WHERE (:desde IS NULL OR i.escaneadoAt >= :desde)
              AND (:hasta IS NULL OR i.escaneadoAt <= :hasta)
            GROUP BY i.sku
            """)
    List<EstadisticaProductoDTO> contarSesionesEscaneadasPorSku(
            @Param("desde") Instant desde,
            @Param("hasta") Instant hasta);

    /** Cuenta SESIONES ÚNICAS que escanearon un SKU y terminaron en pedido no
     *  anulado que incluye ESE mismo SKU — es el numerador correcto para la
     *  tasa de conversión por producto. Dicho con palabras: "de los clientes
     *  que mostraron interés en X, ¿cuántos lo terminaron comprando?".
     *
     *  <p>El join se hace por {@code SesionShowroom.pedidoId} (no es FK estricta
     *  por diseño) contra {@code PedidoShowroom.id}, y por SKU contra
     *  {@code PedidoShowroomItem.sku}. La fecha del filtro aplica sobre
     *  {@code escaneadoAt} para alinear con el denominador. */
    @Query("""
            SELECT new ar.com.leo.showroom.showroom.dto.EstadisticaProductoDTO(
                si.sku, MAX(si.descripcion), COUNT(DISTINCT si.sesion))
            FROM SesionScanItem si
            JOIN ar.com.leo.showroom.pedido.entity.PedidoShowroom p
                ON p.id = si.sesion.pedidoId
            JOIN ar.com.leo.showroom.pedido.entity.PedidoShowroomItem pi
                ON pi.pedido = p AND pi.sku = si.sku
            WHERE p.estado <> ar.com.leo.showroom.pedido.entity.EstadoPedido.ANULADO
              AND (:desde IS NULL OR si.escaneadoAt >= :desde)
              AND (:hasta IS NULL OR si.escaneadoAt <= :hasta)
            GROUP BY si.sku
            """)
    List<EstadisticaProductoDTO> contarSesionesConvertidasPorSku(
            @Param("desde") Instant desde,
            @Param("hasta") Instant hasta);

    /** Cuenta sesiones cerradas en el rango. Una "sesión finalizada" es la que
     *  el operador cerró explícitamente (con o sin pedido) — es el denominador
     *  natural del KPI de conversión.
     *
     *  <p>Solo cuenta atenciones REALES del showroom (con al menos un scan o un
     *  pedido); excluye las sesiones de presupuesto (0 scans, sin pedido) para
     *  no inflar el denominador y bajar artificialmente la conversión. Coherente
     *  con el filtro del listado {@link #buscar}. */
    @Query("""
            SELECT COUNT(s) FROM SesionShowroom s
            WHERE s.finalizadaAt IS NOT NULL
              AND (s.items IS NOT EMPTY OR s.pedidoId IS NOT NULL)
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

    /** Bulk lookup {@code pedidoId → sesionId} para la columna "Origen" del
     *  listado de pedidos. Devuelve [pedidoId, sesionId] por fila; se arma el
     *  mapa en memoria en el caller. */
    @Query("SELECT s.pedidoId, s.id FROM SesionShowroom s WHERE s.pedidoId IN :pedidoIds")
    List<Object[]> findSesionIdsByPedidoIds(@Param("pedidoIds") Collection<Long> pedidoIds);
}
