package ar.com.leo.showroom.catalogo.entity;

import jakarta.persistence.*;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;

/**
 * Tabla singleton (siempre 1 fila con id={@link #SINGLETON_ID}) que persiste
 * metadata global del sync de catálogo — específicamente, cuándo terminó la
 * última sync global exitosa.
 *
 * <p>Antes se usaba {@code MAX(sincronizado_at)} de {@link ProductoCache}, pero
 * ese MAX se rejuvenece con refreshes individuales (ej. {@code /scan} o
 * {@code /refresh-stock}). Eso causaba dos problemas: (1) el banner del
 * frontend parecía fresco aunque la sync global fuera de hace días; (2) el
 * cursor del sync incremental se adelantaba y se salteaba cambios sobre
 * productos no refrescados manualmente. Esta tabla aísla el "última sync
 * GLOBAL" y se usa como fuente de verdad tanto para el banner como para el
 * cursor del incremental.
 */
@Entity
@Table(name = "sync_metadata")
@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class SyncMetadata {

    /** PK fijo del único row. Cualquier upsert apunta a este id. */
    public static final Long SINGLETON_ID = 1L;

    @Id
    private Long id;

    /** Cuándo terminó la última sync global de catálogo (COMPLETED, no CANCELLED ni FAILED). */
    @Column(name = "ultima_sync_global_at")
    private Instant ultimaSyncGlobalAt;
}
