package ar.com.leo.showroom.config.repository;

import ar.com.leo.showroom.config.entity.FormaPago;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;

@Repository
public interface FormaPagoRepository extends JpaRepository<FormaPago, Long> {

    /** Listado para la pantalla de configuración — incluye activas e inactivas. */
    List<FormaPago> findAllByOrderByActivoDescOrdenAscIdAsc();

    /** Listado para el selector del operador en el carrito — solo activas. */
    List<FormaPago> findByActivoTrueOrderByOrdenAscIdAsc();

    /** Para chequear unicidad de nombre al crear/editar. */
    Optional<FormaPago> findByNombreIgnoreCase(String nombre);
}
