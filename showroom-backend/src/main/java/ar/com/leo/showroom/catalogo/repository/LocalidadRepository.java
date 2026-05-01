package ar.com.leo.showroom.catalogo.repository;

import ar.com.leo.showroom.catalogo.entity.Localidad;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface LocalidadRepository extends JpaRepository<Localidad, Long> {

    List<Localidad> findByIdProvinciaOrderByNombreAsc(Long idProvincia);
}
