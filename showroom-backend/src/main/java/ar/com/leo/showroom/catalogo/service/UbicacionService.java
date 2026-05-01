package ar.com.leo.showroom.catalogo.service;

import ar.com.leo.showroom.catalogo.entity.Localidad;
import ar.com.leo.showroom.catalogo.entity.Provincia;
import ar.com.leo.showroom.catalogo.repository.LocalidadRepository;
import ar.com.leo.showroom.catalogo.repository.ProvinciaRepository;
import ar.com.leo.showroom.dux.model.DuxLocalidad;
import ar.com.leo.showroom.dux.model.DuxProvincia;
import ar.com.leo.showroom.dux.service.DuxClient;
import jakarta.transaction.Transactional;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.List;

/**
 * Provincias y localidades persistidas en la BD local.
 *
 * Al primer arranque:
 *  - Si la tabla {@code provincia} está vacía, descarga todas las provincias desde DUX.
 *  - Pre-descarga las localidades de las provincias más usadas en el showroom
 *    (ver {@link #COD_ISO_PRECARGA}).
 *
 * Se guarda página a página (50 items) durante la paginación, así si el backend
 * reinicia o crashea no se pierde el progreso ya descargado. Como el PK es el id
 * de DUX, re-correr la descarga es idempotente (saveAll = upsert).
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class UbicacionService {

    /** cod_iso de las provincias que se precargan al primer arranque. */
    private static final List<String> COD_ISO_PRECARGA = List.of(
            "B", // BUENOS AIRES
            "C"  // CIUDAD AUTONOMA DE BUENOS AIRES
    );

    private final DuxClient duxClient;
    private final ProvinciaRepository provinciaRepo;
    private final LocalidadRepository localidadRepo;

    /**
     * @Async + @EventListener: Spring invoca este método vía proxy (porque el dispatch
     * del evento pasa por la infraestructura de AOP), entonces @Async sí firea acá.
     * Si en cambio dejábamos un @EventListener no-async que llamaba a un método @Async
     * del mismo bean (self-call), el proxy NO se activaba y la descarga corría en el
     * main thread del startup — bloqueando el "Application started" log y haciendo lío
     * con DevTools restart.
     */
    @Async
    @EventListener(ApplicationReadyEvent.class)
    public void inicializar() {
        if (!duxClient.isConfigured()) {
            log.info("UbicacionService - DUX no configurado, salteando inicialización");
            return;
        }
        try {
            if (provinciaRepo.count() == 0) {
                log.info("UbicacionService - tabla provincia vacía, descargando desde DUX");
                descargarYGuardarProvincias();
            }
            for (String codIso : COD_ISO_PRECARGA) {
                provinciaRepo.findByCodIsoIgnoreCase(codIso)
                        .ifPresent(this::asegurarLocalidadesDe);
            }
        } catch (Exception e) {
            log.error("UbicacionService - inicialización falló: {}", e.getMessage(), e);
        }
    }

    public List<Provincia> listarProvincias() {
        List<Provincia> cached = provinciaRepo.findAllByOrderByNombreAsc();
        if (!cached.isEmpty()) return cached;
        if (!duxClient.isConfigured()) return List.of();
        descargarYGuardarProvincias();
        return provinciaRepo.findAllByOrderByNombreAsc();
    }

    public List<Localidad> listarLocalidadesPorCodIso(String codIso) {
        if (codIso == null || codIso.isBlank()) return List.of();
        Provincia prov = provinciaRepo.findByCodIsoIgnoreCase(codIso).orElse(null);
        if (prov == null) return List.of();
        if (prov.getLocalidadesSincronizadasAt() == null) {
            asegurarLocalidadesDe(prov);
        }
        return localidadRepo.findByIdProvinciaOrderByNombreAsc(prov.getId());
    }

    @Transactional
    public synchronized void descargarYGuardarProvincias() {
        List<DuxProvincia> remotas = duxClient.obtenerProvincias();
        if (remotas.isEmpty()) {
            log.warn("UbicacionService - DUX devolvió 0 provincias");
            return;
        }
        for (DuxProvincia r : remotas) {
            if (r.getId() == null || r.getCodIso() == null) continue;
            Provincia entity = provinciaRepo.findById(r.getId())
                    .orElseGet(() -> Provincia.builder().id(r.getId()).build());
            entity.setCodIso(r.getCodIso());
            entity.setNombre(r.getProvincia());
            entity.setIdPais(r.getIdPais());
            entity.setPais(r.getPais());
            provinciaRepo.save(entity);
        }
        log.info("UbicacionService - {} provincias persistidas", remotas.size());
    }

    /**
     * Descarga las localidades de la provincia desde DUX y las guarda página a página.
     * Si el proceso se interrumpe a la mitad, las páginas guardadas sobreviven (PK = id
     * DUX, así que re-correr es idempotente). El timestamp `localidades_sincronizadas_at`
     * solo se setea si la paginación termina sin excepción — esto evita marcar como
     * "completo" un sync interrumpido.
     */
    public synchronized void asegurarLocalidadesDe(Provincia prov) {
        Provincia fresca = provinciaRepo.findById(prov.getId()).orElse(null);
        if (fresca == null) return;
        if (fresca.getLocalidadesSincronizadasAt() != null) return;

        try {
            duxClient.obtenerLocalidadesPorProvincia(fresca.getId(), pagina -> {
                List<Localidad> entidades = pagina.stream()
                        .filter(l -> l.getId() != null && l.getIdProvincia() != null)
                        .map(l -> Localidad.builder()
                                .id(l.getId())
                                .idProvincia(l.getIdProvincia())
                                .nombre(l.getLocalidad())
                                .codPostal(l.getCodPostal())
                                .build())
                        .toList();
                if (!entidades.isEmpty()) {
                    localidadRepo.saveAll(entidades);
                }
            });
            fresca.setLocalidadesSincronizadasAt(Instant.now());
            provinciaRepo.save(fresca);
            log.info("UbicacionService - sincronización terminada para {} (cod_iso={})",
                    fresca.getNombre(), fresca.getCodIso());
        } catch (Exception e) {
            log.error("UbicacionService - sincronización de {} (cod_iso={}) falló: {}",
                    fresca.getNombre(), fresca.getCodIso(), e.getMessage());
        }
    }

    /**
     * Fuerza re-descarga de las localidades de una provincia.
     */
    @Transactional
    public synchronized void recargarProvinciaPorCodIso(String codIso) {
        Provincia prov = provinciaRepo.findByCodIsoIgnoreCase(codIso).orElse(null);
        if (prov == null) return;
        prov.setLocalidadesSincronizadasAt(null);
        provinciaRepo.save(prov);
        asegurarLocalidadesDe(prov);
    }
}
