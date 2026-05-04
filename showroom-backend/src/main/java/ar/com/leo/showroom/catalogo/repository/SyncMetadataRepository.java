package ar.com.leo.showroom.catalogo.repository;

import ar.com.leo.showroom.catalogo.entity.SyncMetadata;
import org.springframework.data.jpa.repository.JpaRepository;

public interface SyncMetadataRepository extends JpaRepository<SyncMetadata, Long> {
}
