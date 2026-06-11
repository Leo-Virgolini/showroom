package ar.com.leo.showroom.cliente.repository;

import ar.com.leo.showroom.cliente.entity.ClienteMaster;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.Optional;

public interface ClienteMasterRepository extends JpaRepository<ClienteMaster, Long> {

    /** Lookup por la clave lógica (teléfono normalizado). Lo usa el upsert y
     *  el merge en {@code PresupuestoComercialService#listarClientes}. */
    Optional<ClienteMaster> findByTelefonoNormalizado(String telefonoNormalizado);

    /** Clientes maestros (no eliminados) con un CUIT/documento dado. El CUIT NO
     *  es único (varios locales de una empresa entran con teléfonos distintos),
     *  por eso devuelve lista — el caller toma el más reciente. Usado para
     *  autocompletar los datos del cliente al tipear el CUIT en el pedido. */
    List<ClienteMaster> findByNroDocAndEliminadoAtIsNull(Long nroDoc);

    /** Clientes con ese CUIT (incluye eliminados), del más reciente al más viejo.
     *  Lo usa el upsert al crear pedido para reusar la fila formal del CUIT. */
    List<ClienteMaster> findByNroDocOrderByActualizadoAtDesc(Long nroDoc);

    /** Autocompletado por razón social o nombre (no eliminados, case-insensitive,
     *  sub-string). Ordena por actualización reciente. El {@link Pageable} limita
     *  la cantidad de sugerencias. */
    @Query("""
            select c from ClienteMaster c
            where c.eliminadoAt is null
              and (lower(c.razonSocial) like lower(concat('%', :texto, '%'))
                or lower(c.nombre) like lower(concat('%', :texto, '%')))
            order by c.actualizadoAt desc
            """)
    List<ClienteMaster> buscarPorRazonSocialONombre(@Param("texto") String texto, Pageable pageable);
}
