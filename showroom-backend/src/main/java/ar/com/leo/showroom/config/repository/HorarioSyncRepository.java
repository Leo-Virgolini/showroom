package ar.com.leo.showroom.config.repository;

import ar.com.leo.showroom.config.entity.HorarioSync;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface HorarioSyncRepository extends JpaRepository<HorarioSync, Long> {

    /** Horarios ordenados cronológicamente — orden esperado por el frontend. */
    List<HorarioSync> findAllByOrderByHoraAscMinutoAsc();
}
