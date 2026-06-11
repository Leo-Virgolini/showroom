package ar.com.leo.showroom.cliente.repository;

import ar.com.leo.showroom.cliente.entity.ClienteMaster;
import org.springframework.data.jpa.repository.JpaRepository;

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
}
