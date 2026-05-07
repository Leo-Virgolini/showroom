package ar.com.leo.showroom.config.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Index;
import jakarta.persistence.Table;
import jakarta.persistence.UniqueConstraint;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

/**
 * Horario diario al que disparar la sincronización automática con DUX (zona AR).
 * Cada fila representa un disparo diario en {@code hora:minuto}. La planilla
 * completa se interpreta en zona America/Argentina/Buenos_Aires.
 *
 * <p>Antes el cron estaba hardcodeado en {@code application.properties}
 * ({@code showroom.cache.refresh-cron}); ahora la configuración es runtime y
 * el {@code HorarioSyncSchedulerService} reprograma los disparos cuando esta
 * tabla cambia.
 */
@Entity
@Table(
        name = "horario_sync",
        uniqueConstraints = @UniqueConstraint(
                name = "uk_horario_sync_hora_minuto",
                columnNames = {"hora", "minuto"}
        ),
        indexes = @Index(name = "idx_horario_sync_orden", columnList = "hora,minuto")
)
@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class HorarioSync {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    /** Hora del día (0..23) en zona AR. */
    @Column(nullable = false)
    private Integer hora;

    /** Minuto de la hora (0..59). */
    @Column(nullable = false)
    private Integer minuto;
}
