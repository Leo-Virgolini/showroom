package ar.com.leo.showroom.presupuesto.repository;

import ar.com.leo.showroom.presupuesto.entity.PresupuestoComercial;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.Instant;
import java.util.Collection;
import java.util.List;

public interface PresupuestoComercialRepository extends JpaRepository<PresupuestoComercial, Long> {

    /** Bulk lookup {@code convertidoEnPedidoId → presupuestoId} para la columna
     *  "Origen" del listado de pedidos. Devuelve [pedidoId, presupuestoId] por
     *  fila; se arma el mapa en memoria en el caller. */
    @Query("SELECT p.convertidoEnPedidoId, p.id FROM PresupuestoComercial p WHERE p.convertidoEnPedidoId IN :pedidoIds")
    List<Object[]> findPresupuestoIdsByPedidoIds(@Param("pedidoIds") Collection<Long> pedidoIds);

    /** Todos los presupuestos activos ordenados por fecha descendente — usado
     *  para construir la vista agrupada por cliente en /clientes (junto con
     *  los pedidos — los datos se unen en memoria en {@code listarClientes}).
     *  La agrupación se hace en memoria (suelen ser cientos, no decenas de
     *  miles), así que no necesitamos un GROUP BY con subqueries. */
    List<PresupuestoComercial> findByEliminadoAtIsNullOrderByCreadoAtDesc();

    /**
     * Búsqueda paginada con filtros opcionales — usada por la pantalla
     * {@code /presupuestos/historial}. Filtra por:
     * <ul>
     *   <li>{@code q}: substring case-insensitive sobre nombre/email/teléfono;
     *       null = sin filtro.</li>
     *   <li>{@code desde}/{@code hasta}: rango de creado_at; null = abierto.</li>
     *   <li>{@code id}: si viene, devuelve solo ese presupuesto (deep-link).</li>
     * </ul>
     * Excluye registros con {@code eliminado_at} no nulo (soft-delete).
     * Ordenamiento se aplica desde el {@link Pageable}.
     */
    @Query("""
        SELECT p FROM PresupuestoComercial p
        WHERE p.eliminadoAt IS NULL
          AND (:id IS NULL OR p.id = :id)
          AND (:q IS NULL OR CAST(p.id AS string) LIKE CONCAT('%', :q, '%')
                          OR LOWER(COALESCE(p.clienteNombre, '')) LIKE LOWER(CONCAT('%', :q, '%'))
                          OR LOWER(COALESCE(p.clienteEmail, ''))  LIKE LOWER(CONCAT('%', :q, '%'))
                          OR LOWER(COALESCE(p.clienteTelefono, '')) LIKE LOWER(CONCAT('%', :q, '%')))
          AND (:desde IS NULL OR p.creadoAt >= :desde)
          AND (:hasta IS NULL OR p.creadoAt <= :hasta)
        """)
    Page<PresupuestoComercial> buscar(@Param("id") Long id,
                                      @Param("q") String q,
                                      @Param("desde") Instant desde,
                                      @Param("hasta") Instant hasta,
                                      Pageable pageable);
}
