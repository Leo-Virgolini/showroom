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

    /** Cliente maestro (no eliminado) con un CUIT/documento dado. El CUIT es
     *  ÚNICO en la tabla (índice único {@code uk_cliente_master_nro_doc}), así que
     *  a lo sumo hay un master no-eliminado con ese documento. Devolvemos lista por
     *  la convención de derivación de Spring Data; el caller toma el más reciente
     *  de forma defensiva. Usado para autocompletar los datos del cliente al tipear
     *  el CUIT en el pedido. */
    List<ClienteMaster> findByNroDocAndEliminadoAtIsNull(Long nroDoc);

    /** Clientes con ese CUIT (incluye eliminados), del más reciente al más viejo.
     *  Lo usa el upsert al crear pedido para reusar la fila formal del CUIT. */
    List<ClienteMaster> findByNroDocOrderByActualizadoAtDesc(Long nroDoc);

    /** Autocompletado por razón social o nombre (no eliminados, case-insensitive,
     *  sub-string). Ordena por actualización reciente. El {@link Pageable} limita
     *  la cantidad de sugerencias. {@code :texto} debe venir con los comodines de
     *  LIKE ya escapados ({@code \\}, {@code %}, {@code _}) — ver
     *  {@code ClienteMasterService.escaparLike}; la cláusula {@code escape '\'} los
     *  trata como literales para que un '%' tipeado no actúe de comodín. */
    @Query("""
            select c from ClienteMaster c
            where c.eliminadoAt is null
              and (lower(c.razonSocial) like lower(concat('%', :texto, '%')) escape '\\'
                or lower(c.nombre) like lower(concat('%', :texto, '%')) escape '\\')
            order by c.actualizadoAt desc
            """)
    List<ClienteMaster> buscarPorRazonSocialONombre(@Param("texto") String texto, Pageable pageable);
}
