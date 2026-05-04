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
 * <p>Antes el banner "última sincronización" mostraba {@code MAX(sincronizado_at)}
 * de {@link ProductoCache}, lo cual incluye refreshes individuales (ej. cuando
 * el operador toca "refrescar" en un producto en {@code /scan}). Eso hacía que
 * el timestamp pareciera fresco aunque la sync global haya sido hace días.
 * Esta tabla aísla el "última sync GLOBAL".
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
