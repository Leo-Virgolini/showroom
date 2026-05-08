package ar.com.leo.showroom.config.repository;

import ar.com.leo.showroom.config.entity.Configuracion;
import org.springframework.data.jpa.repository.JpaRepository;

public interface ConfiguracionRepository extends JpaRepository<Configuracion, String> {
}
