package ar.com.leo.showroom.config.repository;

import ar.com.leo.showroom.config.entity.EscalaDescuento;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface EscalaDescuentoRepository extends JpaRepository<EscalaDescuento, Long> {

    /** Escalones de menor a mayor umbral — orden esperado por el frontend. */
    List<EscalaDescuento> findAllByOrderByUmbralMinAsc();
}
