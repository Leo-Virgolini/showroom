package ar.com.leo.showroom.cliente.repository;

import ar.com.leo.showroom.cliente.entity.ClienteMaster;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.Optional;

public interface ClienteMasterRepository extends JpaRepository<ClienteMaster, Long> {

    /**
     * Listado paginado de clientes (no eliminados) para la pantalla /clientes.
     * Filtra por texto libre {@code q}: substring case-insensitive sobre
     * nombre / razón social / email; y, cuando {@code qDigitos} (los dígitos del
     * query) no está vacío, también sobre el teléfono normalizado y el CUIT. El
     * orden lo provee el {@link Pageable} (la whitelist de campos la resuelve el
     * service). Como la actividad (contadores, último movimiento/total) está
     * materializada en la entidad, este SELECT directo soporta ordenar por
     * cualquiera de esas columnas sin cruzar los movimientos.
     */
    @Query("""
            select c from ClienteMaster c
            where c.eliminadoAt is null
              and (:q is null or :q = ''
                   or lower(coalesce(c.nombre, '')) like lower(concat('%', :q, '%'))
                   or lower(coalesce(c.razonSocial, '')) like lower(concat('%', :q, '%'))
                   or lower(coalesce(c.email, '')) like lower(concat('%', :q, '%'))
                   or (:qDigitos <> '' and coalesce(c.telefonoNormalizado, '') like concat('%', :qDigitos, '%'))
                   or (:qDigitos <> '' and cast(c.nroDoc as string) like concat('%', :qDigitos, '%')))
            """)
    Page<ClienteMaster> buscarPaginado(@Param("q") String q,
                                       @Param("qDigitos") String qDigitos,
                                       Pageable pageable);

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
