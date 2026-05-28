package ar.com.leo.showroom.cotizacion.repository;

import ar.com.leo.showroom.cotizacion.entity.CotizacionFinanciera;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.Instant;

public interface CotizacionFinancieraRepository extends JpaRepository<CotizacionFinanciera, Long> {

    /**
     * Búsqueda paginada para el historial de cotizaciones — mismo patrón que
     * {@code PresupuestoComercialRepository.buscar}. Filtra por:
     * <ul>
     *   <li>{@code q}: substring case-insensitive sobre nombre/email/teléfono.</li>
     *   <li>{@code desde}/{@code hasta}: rango de creado_at.</li>
     *   <li>{@code id}: deep-link a una cotización específica.</li>
     * </ul>
     * Excluye eliminados ({@code eliminadoAt != null}).
     */
    @Query("""
        SELECT c FROM CotizacionFinanciera c
        WHERE c.eliminadoAt IS NULL
          AND (:id IS NULL OR c.id = :id)
          AND (:q IS NULL OR LOWER(COALESCE(c.clienteNombre, '')) LIKE LOWER(CONCAT('%', :q, '%'))
                          OR LOWER(COALESCE(c.clienteEmail, ''))  LIKE LOWER(CONCAT('%', :q, '%'))
                          OR LOWER(COALESCE(c.clienteTelefono, '')) LIKE LOWER(CONCAT('%', :q, '%')))
          AND (:desde IS NULL OR c.creadoAt >= :desde)
          AND (:hasta IS NULL OR c.creadoAt <= :hasta)
        """)
    Page<CotizacionFinanciera> buscar(@Param("id") Long id,
                                     @Param("q") String q,
                                     @Param("desde") Instant desde,
                                     @Param("hasta") Instant hasta,
                                     Pageable pageable);
}
