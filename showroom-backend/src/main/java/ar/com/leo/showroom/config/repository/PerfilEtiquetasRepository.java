package ar.com.leo.showroom.config.repository;

import ar.com.leo.showroom.config.entity.PerfilEtiquetas;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;

@Repository
public interface PerfilEtiquetasRepository extends JpaRepository<PerfilEtiquetas, Long> {

    /** Listado para el dropdown del operador — orden alfabético por nombre. */
    List<PerfilEtiquetas> findAllByOrderByNombreAsc();

    /** Para chequear unicidad de nombre al crear/editar. */
    Optional<PerfilEtiquetas> findByNombreIgnoreCase(String nombre);
}
