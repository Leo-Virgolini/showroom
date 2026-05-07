package ar.com.leo.showroom.config.service;

import ar.com.leo.showroom.catalogo.service.CatalogoSyncService;
import ar.com.leo.showroom.config.entity.HorarioSync;
import ar.com.leo.showroom.config.repository.HorarioSyncRepository;
import ar.com.leo.showroom.dux.service.DuxClient;
import ar.com.leo.showroom.showroom.dto.HorarioSyncDTO;
import jakarta.annotation.PreDestroy;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.annotation.Lazy;
import org.springframework.context.event.EventListener;
import org.springframework.scheduling.TaskScheduler;
import org.springframework.scheduling.support.CronTrigger;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TimeZone;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ScheduledFuture;

/**
 * Gestiona los horarios diarios de sincronización automática con DUX.
 *
 * <p>Antes el cron estaba hardcodeado en {@code application.properties}
 * ({@code showroom.cache.refresh-cron}) y se aplicaba con {@code @Scheduled}.
 * Ahora los horarios viven en la tabla {@code horario_sync} y se pueden editar
 * desde la pantalla de configuración. Cada cambio cancela los disparos
 * pendientes y reprograma todo desde cero.
 *
 * <p>Cada fila se programa con un {@link CronTrigger} fijo a la zona
 * {@code America/Argentina/Buenos_Aires} para que el horario no dependa de la
 * TZ del host (UTC en Docker, AR local, etc.).
 */
@Slf4j
@Service
public class HorarioSyncSchedulerService {

    private static final TimeZone ZONA_AR = TimeZone.getTimeZone("America/Argentina/Buenos_Aires");

    private final HorarioSyncRepository repository;
    private final TaskScheduler taskScheduler;
    private final DuxClient duxClient;
    /** Lazy para romper el ciclo: CatalogoSyncService → ... no lo necesita, pero
     *  Spring evalúa el grafo completo y un disparo accidental al inicio podría
     *  cargar dependencias antes de tiempo. */
    private final CatalogoSyncService catalogoSync;

    /**
     * Self-injection lazy para que las llamadas internas a {@link #listar()}
     * (anotado con {@code @Transactional}) pasen por el proxy y no por el
     * objeto desnudo — sin esto el {@code @Transactional} se ignoraría.
     */
    @Autowired
    @Lazy
    private HorarioSyncSchedulerService self;

    /** Map idHorario → ScheduledFuture activo. Se cancela y reemplaza en cada reload. */
    private final Map<Long, ScheduledFuture<?>> tareasActivas = new ConcurrentHashMap<>();

    public HorarioSyncSchedulerService(
            HorarioSyncRepository repository,
            TaskScheduler taskScheduler,
            DuxClient duxClient,
            @Lazy CatalogoSyncService catalogoSync) {
        this.repository = repository;
        this.taskScheduler = taskScheduler;
        this.duxClient = duxClient;
        this.catalogoSync = catalogoSync;
    }

    /**
     * Programa los horarios al arrancar la app. Si la tabla está vacía no se
     * programa nada — el operador queda a cargo de habilitar la sync periódica
     * desde la pantalla de configuración.
     */
    @EventListener(ApplicationReadyEvent.class)
    public void programarAlIniciar() {
        reprogramarTodo();
    }

    /**
     * Cancela todos los disparos pendientes al apagar la app. Sin esto, los
     * tests y los reinicios rápidos podían dejar tareas huérfanas en el pool.
     */
    @PreDestroy
    public void detenerTodo() {
        cancelarTodas();
    }

    /** Lista de horarios persistidos, ordenados cronológicamente. */
    @Transactional(readOnly = true)
    public List<HorarioSync> listar() {
        return repository.findAllByOrderByHoraAscMinutoAsc();
    }

    /**
     * Reemplaza atómicamente la lista de horarios. Mismo patrón que
     * {@code EscalaDescuentoService.reemplazar}: borrar todo + insertar la
     * lista nueva. Una vez persistido, reprograma los disparos.
     *
     * <p>Validaciones (todas obligatorias para no programar tareas inválidas):
     * <ul>
     *   <li>{@code hora} y {@code minuto} no nulos.
     *   <li>{@code 0 <= hora <= 23}, {@code 0 <= minuto <= 59}.
     *   <li>Sin duplicados (dos horarios con mismo hora+minuto).
     * </ul>
     */
    @Transactional
    public List<HorarioSync> reemplazar(List<HorarioSyncDTO> nuevos) {
        if (nuevos == null) nuevos = List.of();
        validar(nuevos);
        repository.deleteAllInBatch();
        repository.flush();
        for (HorarioSyncDTO dto : nuevos) {
            repository.save(HorarioSync.builder()
                    .hora(dto.hora())
                    .minuto(dto.minuto())
                    .build());
        }
        log.info("Horarios de sincronización reemplazados: {} disparos diarios", nuevos.size());
        List<HorarioSync> persistidos = repository.findAllByOrderByHoraAscMinutoAsc();
        // Reprogramar fuera del flush no estrictamente necesario (los horarios
        // ya están listados), pero hacerlo después de la transacción permite
        // que un rollback no deje el scheduler reprogramado con datos viejos.
        reprogramar(persistidos);
        return persistidos;
    }

    private void validar(List<HorarioSyncDTO> nuevos) {
        List<String> claves = new ArrayList<>();
        for (int i = 0; i < nuevos.size(); i++) {
            HorarioSyncDTO h = nuevos.get(i);
            String prefijo = "Horario #" + (i + 1) + ": ";
            if (h.hora() == null || h.minuto() == null) {
                throw new IllegalArgumentException(prefijo + "hora y minuto son requeridos");
            }
            if (h.hora() < 0 || h.hora() > 23) {
                throw new IllegalArgumentException(prefijo + "la hora debe estar entre 0 y 23");
            }
            if (h.minuto() < 0 || h.minuto() > 59) {
                throw new IllegalArgumentException(prefijo + "el minuto debe estar entre 0 y 59");
            }
            String clave = h.hora() + ":" + h.minuto();
            if (claves.contains(clave)) {
                throw new IllegalArgumentException(prefijo + "horario duplicado (" + clave + ")");
            }
            claves.add(clave);
        }
    }

    /** Recarga los horarios desde la BD y reprograma todos los disparos. */
    public void reprogramarTodo() {
        reprogramar(self.listar());
    }

    private synchronized void reprogramar(List<HorarioSync> horarios) {
        cancelarTodas();
        if (horarios.isEmpty()) {
            log.info("Sin horarios configurados — sync automática deshabilitada");
            return;
        }
        for (HorarioSync h : horarios) {
            programarHorario(h);
        }
        log.info("Sync automática habilitada con {} disparo(s) diario(s) (zona AR): {}",
                horarios.size(), horarios.stream()
                        .map(h -> String.format("%02d:%02d", h.getHora(), h.getMinuto()))
                        .toList());
    }

    private void programarHorario(HorarioSync h) {
        // Cron de 6 campos (Spring): seg min hora día mes díaSemana.
        String cron = String.format("0 %d %d * * *", h.getMinuto(), h.getHora());
        CronTrigger trigger = new CronTrigger(cron, ZONA_AR);
        ScheduledFuture<?> future = taskScheduler.schedule(this::dispararSync, trigger);
        tareasActivas.put(h.getId(), future);
    }

    private void cancelarTodas() {
        tareasActivas.values().forEach(f -> f.cancel(false));
        tareasActivas.clear();
    }

    /**
     * Lo que cada disparo programado ejecuta. Misma lógica que el
     * {@code @Scheduled} viejo: si DUX no está configurado, salteamos el sync.
     */
    private void dispararSync() {
        if (!duxClient.isConfigured()) {
            log.info("Sync DUX salteado: cliente no configurado");
            return;
        }
        catalogoSync.sincronizarCatalogoCompleto();
    }
}
