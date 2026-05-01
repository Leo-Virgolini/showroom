package ar.com.leo.showroom.catalogo.repository;

import ar.com.leo.showroom.catalogo.entity.Provincia;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;

public interface ProvinciaRepository extends JpaRepository<Provincia, Long> {

    Optional<Provincia> findByCodIsoIgnoreCase(String codIso);

    List<Provincia> findAllByOrderByNombreAsc();
}
