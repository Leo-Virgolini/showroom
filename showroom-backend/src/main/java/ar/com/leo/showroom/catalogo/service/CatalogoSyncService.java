package ar.com.leo.showroom.catalogo.service;

import ar.com.leo.showroom.catalogo.entity.ProductoCache;
import ar.com.leo.showroom.catalogo.entity.SyncMetadata;
import ar.com.leo.showroom.catalogo.repository.ProductoCacheRepository;
import ar.com.leo.showroom.catalogo.repository.SyncMetadataRepository;
import ar.com.leo.showroom.dux.model.DuxItem;
import ar.com.leo.showroom.dux.model.DuxPrecio;
import ar.com.leo.showroom.dux.model.DuxStock;
import ar.com.leo.showroom.dux.service.DuxClient;
import ar.com.leo.showroom.events.SyncEvent;
import ar.com.leo.showroom.events.SyncEventService;
import jakarta.transaction.Transactional;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.annotation.Lazy;
import org.springframework.context.event.EventListener;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.stream.Collectors;

/**
 * Sincroniza el cache local con DUX:
 *  - Full sync periódico (todos los items, precios y stock).
 *  - Refresh on-demand para SKUs específicos antes de cerrar un pedido.
 *
 * Solo lee de DUX, nunca escribe. PVP se extrae del precio cuyo nombre coincide
 * con la lista configurada (KT GASTRO).
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class CatalogoSyncService {

    private final DuxClient duxClient;
    private final ProductoCacheRepository repository;
    private final SyncMetadataRepository syncMetadataRepository;
    private final SyncEventService eventService;

    /**
     * Self-injection para que las llamadas internas a métodos con {@code @Async}
     * o {@code @Transactional} pasen por el proxy de Spring. Sin esto, los
     * métodos internos invocados con {@code this.metodo()} hacen self-invocation
     * y los aspects no se aplican — el sync explotaba con LazyInitializationException
     * porque {@code @Transactional} se ignoraba al venir de un async self-invocado.
     * {@code @Lazy} previene el ciclo de bean al inyectar el propio servicio.
     */
    @Autowired
    @Lazy
    private CatalogoSyncService self;

    private final AtomicBoolean syncEnCurso = new AtomicBoolean(false);
    /** Flag de cancelación cooperativa. El loop de DUX lo chequea entre páginas
     *  y aborta limpiamente si lo encuentra true. Se resetea al final de cada sync. */
    private final AtomicBoolean cancelarSolicitado = new AtomicBoolean(false);
    private volatile Instant syncIniciadoAt;

    /**
     * Al arrancar la app, si el cache está vacío disparamos un sync completo
     * automáticamente (en background, no bloquea el startup). Si ya hay datos,
     * dejamos que el cron incremental los mantenga al día.
     */
    @EventListener(ApplicationReadyEvent.class)
    public void syncAlIniciar() {
        long total = repository.count();
        Optional<Instant> ultima = getUltimaSyncGlobalAt();
        log.info("=== Backend showroom listo ===");
        log.info("  DUX configurado: {}", duxClient.isConfigured());
        log.info("  Productos en cache: {}", total);
        log.info("  Última sync global: {}", ultima.map(Instant::toString).orElse("nunca"));
        log.info("  Lista de precios objetivo: {}", duxClient.getProperties().listaPreciosNombre());

        if (!duxClient.isConfigured()) {
            log.info("Sync inicial salteado: DUX no configurado");
            return;
        }
        if (total > 0) {
            log.info("Cache ya poblado — el cron mantendrá la sincronización");
            return;
        }
        log.info("Cache vacío al arrancar — disparando sync inicial en background");
        self.sincronizarCatalogoCompletoAsync();
    }

    /**
     * Versión async para disparar manualmente desde el controller sin bloquear
     * la respuesta HTTP — Spring usa su TaskExecutor (gestionado en shutdown)
     * en lugar de un Thread suelto.
     */
    @Async
    public void sincronizarCatalogoCompletoAsync() {
        self.sincronizarCatalogoCompleto(false);
    }

    /** Versión async que permite forzar un sync completo (no incremental). */
    @Async
    public void sincronizarCatalogoCompletoAsync(boolean forzarCompleto) {
        self.sincronizarCatalogoCompleto(forzarCompleto);
    }

    /**
     * Sync incremental: si el cache ya tiene datos, pide a DUX solo lo que cambió
     * desde el último sincronizado (con 1 min de margen por drift de reloj).
     * Si el cache está vacío, hace el sync completo (~15 min para ~5800 items).
     */
    public int sincronizarCatalogoCompleto() {
        return sincronizarCatalogoCompleto(false);
    }

    /**
     * Orquestador del sync. La descarga de DUX (~15 min por el rate limit) corre
     * SIN transacción para no mantener una conexión a la BD ocupada todo ese tiempo
     * ni inflar la sesión Hibernate con miles de objetos. La persistencia se hace
     * después en una transacción corta delegada a {@link #persistirItems}.
     *
     * @param forzarCompleto si es true, ignora el último sincronizado_at del cache
     *                       y descarga TODO el catálogo desde DUX (15 min para ~5800 items).
     *                       Útil para resetear el cache si se sospecha que divergió.
     */
    public int sincronizarCatalogoCompleto(boolean forzarCompleto) {
        if (!syncEnCurso.compareAndSet(false, true)) {
            log.warn("Ya hay un sync en curso");
            return 0;
        }
        cancelarSolicitado.set(false); // reset por las dudas de un cancel viejo
        Instant inicio = Instant.now();
        syncIniciadoAt = inicio;
        eventService.publish("sync", SyncEvent.started(inicio));
        try {
            String listaObjetivo = duxClient.getProperties().listaPreciosNombre();
            // Usamos ultimaSyncGlobalAt (de sync_metadata) en vez de
            // MAX(producto_cache.sincronizado_at): el MAX se rejuvenece con
            // refreshes individuales (/scan, /refresh-stock), lo que haría que
            // el incremental se saltee cambios sobre productos no refrescados.
            // getUltimaSyncGlobalAt() ya cae en el MAX si sync_metadata está
            // vacío (deploy inicial sobre BD existente).
            Instant desde = forzarCompleto
                    ? null
                    : getUltimaSyncGlobalAt()
                            .map(t -> t.minus(1, ChronoUnit.MINUTES))
                            .orElse(null);
            if (forzarCompleto) {
                log.info("Sync FORZADO - descargando todo el catálogo desde DUX...");
            } else if (desde == null) {
                log.info("Cache vacío - sync completo del catálogo desde DUX...");
            } else {
                log.info("Sync incremental desde {}", desde);
            }
            // FUERA de transacción — la descarga puede tardar ~15 min y no debe
            // ocupar conexión BD ni inflar la sesión Hibernate.
            List<DuxItem> items = duxClient.obtenerTodosLosItems(
                    desde,
                    (actual, total) -> eventService.publish("sync", SyncEvent.progress(inicio, actual, total)),
                    cancelarSolicitado::get);
            log.info("DUX devolvió {} items", items.size());

            // Persistencia DENTRO de una transacción corta (vía proxy con self-injection).
            int actualizados = self.persistirItems(items, listaObjetivo);

            if (cancelarSolicitado.get()) {
                log.info("Sync cancelado por el operador: {} productos guardados parcialmente", actualizados);
                eventService.publish("sync", SyncEvent.cancelled(inicio, actualizados));
            } else {
                log.info("Sync completado: {} productos actualizados", actualizados);
                // Solo persistimos el timestamp cuando la sync global termina OK.
                // Cancelaciones y fallos no cuentan como "última sync exitosa".
                self.marcarUltimaSyncGlobal(Instant.now());
                eventService.publish("sync", SyncEvent.completed(inicio, actualizados));
            }
            return actualizados;
        } catch (RuntimeException ex) {
            log.error("Sync falló: {}", ex.getMessage(), ex);
            eventService.publish("sync", SyncEvent.failed(inicio, ex.getMessage()));
            throw ex;
        } finally {
            syncEnCurso.set(false);
            cancelarSolicitado.set(false);
            syncIniciadoAt = null;
        }
    }

    /**
     * Persiste los items descargados de DUX en una transacción corta (~10-30s
     * típicos, vs. los ~15 min del download). Hibernate batch_size=50 + el
     * rewriteBatchedStatements del JDBC URL agrupan los inserts/updates en
     * lotes — para ~5800 productos pasa de ~5800 round-trips a ~120.
     */
    @Transactional
    public int persistirItems(List<DuxItem> items, String listaObjetivo) {
        List<String> skus = items.stream()
                .map(DuxItem::getCodItem)
                .filter(s -> s != null && !s.isBlank())
                .map(String::trim)
                .toList();
        Map<String, ProductoCache> existentes = repository.findBySkuIn(skus).stream()
                .collect(Collectors.toMap(ProductoCache::getSku, p -> p));

        Instant ahora = Instant.now();
        List<ProductoCache> upserts = new java.util.ArrayList<>(skus.size());

        for (DuxItem item : items) {
            if (item.getCodItem() == null || item.getCodItem().isBlank()) continue;
            String sku = item.getCodItem().trim();

            ProductoCache pc = existentes.get(sku);
            if (pc == null) {
                pc = ProductoCache.builder().sku(sku).build();
            }
            aplicarItem(pc, item, listaObjetivo, ahora);
            upserts.add(pc);
        }

        repository.saveAll(upserts);
        return upserts.size();
    }

    public Optional<Instant> getSyncIniciadoAt() {
        return Optional.ofNullable(syncIniciadoAt);
    }

    /**
     * Refresca on-demand una lista de SKUs (típicamente los del carrito).
     * Cada SKU = 1 request DUX, así que lleva ~7s por SKU.
     *
     * <p>SIN @Transactional acá: la descarga puede tardar ~70s para un carrito
     * de 10 items y mantener una conexión JDBC + locks abiertos durante todo
     * ese tiempo es desperdicio. La persistencia se hace en una transacción
     * corta dedicada via {@link #persistirRefresh}, mismo patrón que
     * {@link #sincronizarCatalogoCompleto}.
     */
    public List<ProductoCache> refrescarSkus(List<String> skus) {
        if (skus == null || skus.isEmpty()) return List.of();
        List<String> limpios = skus.stream()
                .filter(s -> s != null && !s.isBlank())
                .map(String::trim)
                .toList();
        if (limpios.isEmpty()) return List.of();

        String listaObjetivo = duxClient.getProperties().listaPreciosNombre();
        // Descarga FUERA de transacción — esto es lo lento (~7s por SKU).
        List<DuxItem> items = new java.util.ArrayList<>(limpios.size());
        for (String sku : limpios) {
            Optional<DuxItem> opt = duxClient.obtenerItemPorSku(sku);
            if (opt.isEmpty()) {
                log.warn("Refresh - SKU {} no encontrado en DUX", sku);
                continue;
            }
            items.add(opt.get());
        }
        if (items.isEmpty()) return List.of();
        // Persistencia DENTRO de una transacción corta (vía proxy con self-injection).
        return self.persistirRefresh(items, listaObjetivo);
    }

    @Transactional
    public List<ProductoCache> persistirRefresh(List<DuxItem> items, String listaObjetivo) {
        List<String> skus = items.stream()
                .map(DuxItem::getCodItem)
                .filter(s -> s != null && !s.isBlank())
                .map(String::trim)
                .toList();
        Map<String, ProductoCache> existentes = repository.findBySkuIn(skus).stream()
                .collect(Collectors.toMap(ProductoCache::getSku, p -> p));
        Instant ahora = Instant.now();
        List<ProductoCache> resultado = new java.util.ArrayList<>(items.size());
        for (DuxItem item : items) {
            String sku = item.getCodItem().trim();
            ProductoCache pc = existentes.get(sku);
            if (pc == null) {
                pc = ProductoCache.builder().sku(sku).build();
            }
            aplicarItem(pc, item, listaObjetivo, ahora);
            resultado.add(pc);
        }
        repository.saveAll(resultado);
        return resultado;
    }

    public Map<String, ProductoCache> obtenerPorSkus(List<String> skus) {
        return repository.findBySkuIn(skus).stream()
                .collect(Collectors.toMap(ProductoCache::getSku, p -> p));
    }

    /**
     * Busca por SKU exacto y, si no encuentra, por código de barras (EAN).
     * El scan del showroom acepta ambos: el operador puede tipear el SKU o
     * escanear el código de barras impreso en el producto/etiqueta.
     */
    public Optional<ProductoCache> buscarPorSkuOEan(String codigo) {
        if (codigo == null) return Optional.empty();
        String limpio = codigo.trim();
        if (limpio.isEmpty()) return Optional.empty();
        return repository.findBySku(limpio)
                .or(() -> repository.findByCodigoBarra(limpio).stream().findFirst());
    }

    public boolean isSyncEnCurso() {
        return syncEnCurso.get();
    }

    /**
     * Solicita cancelar el sync en curso. Es cooperativo: el flag se chequea
     * entre cada página de DUX, así que el cancel toma efecto en hasta ~7s
     * (lo que tarda la request en vuelo). Los items ya descargados se guardan
     * (no se pierde el trabajo hecho).
     */
    public boolean cancelarSync() {
        if (!syncEnCurso.get()) return false;
        cancelarSolicitado.set(true);
        log.info("Cancelación de sync solicitada");
        return true;
    }

    // =====================================================
    // Helpers
    // =====================================================

    private void aplicarItem(ProductoCache pc, DuxItem item, String listaObjetivo, Instant ahora) {
        pc.setDescripcion(truncar(item.getItem(), 200));
        pc.setPorcIva(parseBigDecimal(item.getPorcIva(), 2));
        pc.setHabilitado(item.getHabilitado() == null ? null : "S".equalsIgnoreCase(item.getHabilitado().trim()));
        pc.setPvpKtGastroConIva(extraerPrecio(item, listaObjetivo));
        pc.setStockTotal(sumarStock(item.getStock()));
        sincronizarCodigosBarra(pc, item.getCodigosBarra());
        pc.setSincronizadoAt(ahora);
    }

    /**
     * Reescribe el Set de códigos de barra del producto. Limpiamos y volvemos a
     * agregar (en lugar de hacer setCodigosBarra(nuevoSet)) porque Hibernate
     * trackea modificaciones a la colección existente para emitir el delta
     * correcto de inserts/deletes en la tabla lateral.
     */
    private void sincronizarCodigosBarra(ProductoCache pc, List<String> codigos) {
        if (pc.getCodigosBarra() == null) {
            pc.setCodigosBarra(new HashSet<>());
        }
        pc.getCodigosBarra().clear();
        if (codigos == null) return;
        for (String c : codigos) {
            if (c == null) continue;
            String trimmed = c.trim();
            if (!trimmed.isEmpty() && trimmed.length() <= 32) {
                pc.getCodigosBarra().add(trimmed);
            }
        }
    }

    private BigDecimal extraerPrecio(DuxItem item, String listaObjetivo) {
        if (item.getPrecios() == null) return null;
        String objetivo = listaObjetivo == null ? "" : listaObjetivo.trim();
        for (DuxPrecio p : item.getPrecios()) {
            if (p.getNombre() != null && p.getNombre().trim().equalsIgnoreCase(objetivo)) {
                return parseBigDecimal(p.getPrecio(), 4);
            }
        }
        return null;
    }

    private Integer sumarStock(List<DuxStock> stocks) {
        if (stocks == null || stocks.isEmpty()) return 0;
        int total = 0;
        for (DuxStock s : stocks) {
            if (s == null) continue;
            String d = s.getStockDisponible();
            if (d == null || d.isBlank()) continue;
            String entero = d.trim().replace(",", ".").split("\\.")[0];
            try {
                total += Integer.parseInt(entero);
            } catch (NumberFormatException e) {
                // Si DUX cambia el formato (ej. miles con punto, notación
                // científica), no sumamos nada y avisamos. Sin este log la
                // diferencia se traga silenciosamente y el operador ve menos
                // stock del real sin entender por qué.
                log.warn("Stock con formato inesperado del depósito {}: '{}'", s.getId(), d);
            }
        }
        return total;
    }

    private BigDecimal parseBigDecimal(String s, int scale) {
        if (s == null || s.isBlank()) return null;
        try {
            return new BigDecimal(s.trim().replace(",", ".")).setScale(scale, RoundingMode.HALF_UP);
        } catch (NumberFormatException e) {
            log.warn("Número con formato inesperado de DUX: '{}'", s);
            return null;
        }
    }

    private String truncar(String s, int max) {
        if (s == null) return null;
        String t = s.trim();
        return t.length() > max ? t.substring(0, max) : t;
    }

    /**
     * Upsert del único row de {@link SyncMetadata}. Llamado solo cuando la sync
     * global terminó OK (no para cancelaciones ni fallos). Va en su propia
     * transacción corta para no atar el commit al resto del flujo de sync.
     */
    @Transactional
    public void marcarUltimaSyncGlobal(Instant cuando) {
        SyncMetadata meta = syncMetadataRepository.findById(SyncMetadata.SINGLETON_ID)
                .orElseGet(() -> SyncMetadata.builder()
                        .id(SyncMetadata.SINGLETON_ID)
                        .build());
        meta.setUltimaSyncGlobalAt(cuando);
        syncMetadataRepository.save(meta);
    }

    /**
     * Devuelve cuándo terminó la última sync global exitosa. Si nunca corrió
     * una (sync_metadata vacío), devuelve empty — el frontend oculta el banner
     * y el cursor del incremental cae en null, lo que dispara un sync completo
     * la próxima vez. Antes se caía a {@code MAX(producto_cache.sincronizado_at)}
     * como fallback, pero ese MAX se contamina con refreshes individuales y con
     * items persistidos por syncs cancelados, así que el banner reportaba
     * "fresco" sin que hubiera habido una sync global exitosa.
     */
    public Optional<Instant> getUltimaSyncGlobalAt() {
        return syncMetadataRepository.findById(SyncMetadata.SINGLETON_ID)
                .map(SyncMetadata::getUltimaSyncGlobalAt);
    }
}
