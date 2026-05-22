package ar.com.leo.showroom.cliente.repository;

import ar.com.leo.showroom.cliente.entity.ClienteMaster;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.Optional;

public interface ClienteMasterRepository extends JpaRepository<ClienteMaster, Long> {

    /** Lookup por la clave lógica (teléfono normalizado). Lo usa el upsert y
     *  el merge en {@code PresupuestoComercialService#listarClientes}. */
    Optional<ClienteMaster> findByTelefonoNormalizado(String telefonoNormalizado);
}
