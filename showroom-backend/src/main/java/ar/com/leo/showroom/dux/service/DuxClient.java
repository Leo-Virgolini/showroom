package ar.com.leo.showroom.dux.service;

import ar.com.leo.showroom.common.exception.ServiceNotConfiguredException;
import ar.com.leo.showroom.common.exception.SyncCancelledException;
import ar.com.leo.showroom.dux.DuxRetryHandler;
import ar.com.leo.showroom.dux.config.DuxProperties;
import ar.com.leo.showroom.dux.model.DuxItem;
import ar.com.leo.showroom.dux.model.DuxLocalidad;
import ar.com.leo.showroom.dux.model.DuxProvincia;
import ar.com.leo.showroom.dux.model.DuxResponse;
import ar.com.leo.showroom.dux.model.TokensDux;
import ar.com.leo.showroom.events.SyncEvent;
import ar.com.leo.showroom.events.SyncEventService;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import jakarta.annotation.PostConstruct;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestClient;

import java.io.File;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Paths;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.function.BiConsumer;
import java.util.function.Consumer;

/**
 * Cliente de bajo nivel para la API de DUX.
 * Solo expone operaciones de lectura sobre catálogo/precios/stock + creación de pedidos.
 * NO toca la lista de precios ni los items (sistema read-only sobre productos).
 */
@Slf4j
@Service
public class DuxClient {

    private static final long BASE_WAIT_MS = 5000L;
    private static final int MAX_INTENTOS_VACIOS = 3;
    private static final ZoneId ZONA_DUX = ZoneId.of("America/Argentina/Buenos_Aires");
    // Probando con `HH:mm:ss` por si DUX es más estricto en la versión de
    // su API que esta cuenta tiene (la doc oficial dice `HH:ss`, super-master
    // usa `HH:mm` — quizás ninguno filtra exacto y `mm:ss` es lo que pide).
    private static final DateTimeFormatter DUX_FECHA_HORA = DateTimeFormatter.ofPattern("ddMMyyyy HH:mm:ss");

    private final RestClient restClient;
    private final DuxProperties properties;
    private final ObjectMapper objectMapper;
    private final SyncEventService eventService;

    @Value("${app.secrets-dir}")
    private String secretsDir;

    private DuxRetryHandler retryHandler;
    private TokensDux tokens;
    private volatile Long cachedListaPrecioId;

    public DuxClient(RestClient duxRestClient, DuxProperties properties, ObjectMapper objectMapper,
                     SyncEventService eventService) {
        this.restClient = duxRestClient;
        this.properties = properties;
        this.objectMapper = objectMapper;
        this.eventService = eventService;
    }

    @PostConstruct
    public void init() {
        this.retryHandler = new DuxRetryHandler(
                restClient,
                BASE_WAIT_MS,
                properties.rateLimitPerSecond(),
                this::onRateLimit
        );
        cargarTokens();
    }

    /**
     * Callback que se dispara cuando 429 se acumula varios reintentos consecutivos.
     * Publicamos un SSE solo para GETs (sync de catálogo) — un POST con 429 es
     * un pedido individual del operador y mostrar "rate limit en sync" a los demás
     * usuarios sería confuso (el banner es global).
     */
    private void onRateLimit(int intento, long esperandoMs, String op) {
        if (!"GET".equals(op)) return;
        eventService.publish("sync", SyncEvent.rateLimited(Instant.now(), esperandoMs, intento));
    }

    public boolean isConfigured() {
        return tokens != null && tokens.token != null && !tokens.token.isBlank();
    }

    public DuxProperties getProperties() {
        return properties;
    }

    // =====================================================
    // LISTA DE PRECIOS
    // =====================================================

    /**
     * Obtiene el ID de la lista "KT GASTRO" (configurada en dux.lista-precios-nombre).
     * Cachea el resultado en memoria, no se recarga seguido.
     */
    public long obtenerIdListaPrecios() {
        if (cachedListaPrecioId != null) return cachedListaPrecioId;
        verificarTokens();

        // HIGH: este lookup lo dispara el primer scan/pedido — si está en frío,
        // no queremos que quede atrás de las páginas pendientes del sync.
        String response = retryHandler.get("/listaprecioventa", tokens.token, String.class, null, true);
        try {
            JsonNode root = objectMapper.readTree(response);
            if (!root.isArray()) {
                throw new IllegalStateException("Respuesta de listaprecioventa no es array");
            }
            String objetivo = properties.listaPreciosNombre();
            for (JsonNode node : root) {
                String nombre = node.path("lista_precio_venta").asText("");
                if (nombre.equalsIgnoreCase(objetivo)) {
                    cachedListaPrecioId = node.path("id_lista_precio_venta").asLong();
                    log.info("DUX - Lista de precios '{}' resuelta a id={}", objetivo, cachedListaPrecioId);
                    return cachedListaPrecioId;
                }
            }
            throw new IllegalStateException("Lista de precios '" + objetivo + "' no encontrada en DUX");
        } catch (Exception e) {
            throw new RuntimeException("Error parseando lista de precios DUX", e);
        }
    }

    // =====================================================
    // ITEMS (read-only)
    // =====================================================

    /**
     * Busca un item por SKU. Devuelve Optional.empty() si no existe.
     */
    public Optional<DuxItem> obtenerItemPorSku(String sku) {
        verificarTokens();
        long idLista = obtenerIdListaPrecios();
        // HIGH: scan ad-hoc del operador — latencia visible en pantalla.
        String response = retryHandler.get(
                "/items?codigoItem=" + sku + "&idListaPrecio=" + idLista,
                tokens.token, String.class, null, true);
        if (response == null) return Optional.empty();

        try {
            DuxResponse parsed = objectMapper.readValue(response, DuxResponse.class);
            if (parsed.getResults() != null && !parsed.getResults().isEmpty()) {
                return Optional.of(parsed.getResults().getFirst());
            }
        } catch (Exception e) {
            log.error("DUX - Error parseando item {}: {}", sku, e.getMessage());
        }
        return Optional.empty();
    }

    /**
     * Pagina todos los items del catálogo. Cada page consume 1 cuota del rate limit (1 cada 7s).
     */
    public List<DuxItem> obtenerTodosLosItems() {
        return obtenerTodosLosItems(null, null, null);
    }

    public List<DuxItem> obtenerTodosLosItems(Instant desde) {
        return obtenerTodosLosItems(desde, null, null);
    }

    public List<DuxItem> obtenerTodosLosItems(Instant desde, BiConsumer<Integer, Integer> onProgreso) {
        return obtenerTodosLosItems(desde, onProgreso, null);
    }

    /**
     * Variante incremental con callback de progreso y soporte de cancelación.
     *  - {@code onProgreso}: recibe `(itemsTraídosHastaAhora, totalEsperado)` después
     *    de cada página descargada. Útil para emitir eventos SSE de progreso.
     *  - {@code esCancelado}: si retorna true, se aborta el loop entre páginas (no
     *    interrumpe la request en vuelo, pero la próxima no se dispara). Devolvemos
     *    los items que ya teníamos hasta ese punto.
     */
    public List<DuxItem> obtenerTodosLosItems(
            Instant desde,
            BiConsumer<Integer, Integer> onProgreso,
            java.util.function.BooleanSupplier esCancelado) {
        verificarTokens();
        long idLista = obtenerIdListaPrecios();
        List<DuxItem> all = new ArrayList<>();
        int offset = 0;
        int total = Integer.MAX_VALUE;
        int limit = properties.itemsPerPage();
        int vacios = 0;

        String fechaParam = "";
        if (desde != null) {
            String fmt = DUX_FECHA_HORA.format(desde.atZone(ZONA_DUX));
            fechaParam = "&fecha=" + URLEncoder.encode(fmt, StandardCharsets.UTF_8);
            log.info("DUX sync incremental - filtrando por fecha >= {}", fmt);
        }

        while (offset < total) {
            if (esCancelado != null && esCancelado.getAsBoolean()) {
                log.info("DUX sync cancelado por el operador en offset={} ({} items traídos)", offset, all.size());
                break;
            }
            String response;
            try {
                // Pasamos el supplier al retry handler — sin esto, un 429 puede
                // mantener al thread hasta ~17 min en backoff sin atender el cancel.
                response = retryHandler.get(
                        "/items?offset=" + offset + "&limit=" + limit
                                + "&idListaPrecio=" + idLista + fechaParam,
                        tokens.token, String.class, esCancelado);
            } catch (SyncCancelledException e) {
                log.info("DUX sync cancelado durante request en offset={} ({} items traídos)", offset, all.size());
                break;
            }
            if (response == null) break;

            DuxResponse parsed;
            try {
                parsed = objectMapper.readValue(response, DuxResponse.class);
            } catch (Exception e) {
                log.error("DUX - Error parseando página offset={}: {}", offset, e.getMessage());
                break;
            }

            if (parsed.getPaging() != null) {
                int t = parsed.getPaging().getTotal();
                if (t > 0) total = t;
            }

            if (parsed.getResults() == null || parsed.getResults().isEmpty()) {
                if (++vacios >= MAX_INTENTOS_VACIOS) break;
                offset += limit;
                continue;
            }
            vacios = 0;
            all.addAll(parsed.getResults());
            // Progreso página a página en DEBUG: para ~5800 items son ~120 líneas
            // por sync, ruidoso en logs persistentes. El banner SSE ya muestra el
            // progreso a los operadores; el resumen final ("DUX devolvió N items")
            // queda en INFO en CatalogoSyncService.
            log.debug("DUX sync - {}/{}", all.size(), total);
            if (onProgreso != null) {
                int totalReportado = total == Integer.MAX_VALUE ? all.size() : total;
                try {
                    onProgreso.accept(all.size(), totalReportado);
                } catch (Exception ex) {
                    log.warn("Error en callback de progreso: {}", ex.getMessage());
                }
            }
            offset += limit;
            if (all.size() >= total) break;
        }
        return all;
    }

    // =====================================================
    // PROVINCIAS / LOCALIDADES (read-only, datos casi estáticos)
    // =====================================================

    /**
     * Lista todas las provincias y CABA. Respuesta DUX: array directo.
     * Doc: https://duxsoftware.readme.io/reference/consultar-provincias
     */
    public List<DuxProvincia> obtenerProvincias() {
        verificarTokens();
        String response = retryHandler.get("/provincias", tokens.token, String.class);
        if (response == null) return List.of();
        try {
            JsonNode root = objectMapper.readTree(response);
            if (!root.isArray()) {
                log.warn("DUX - Respuesta de provincias no es array");
                return List.of();
            }
            List<DuxProvincia> list = new ArrayList<>(root.size());
            for (JsonNode n : root) {
                list.add(objectMapper.treeToValue(n, DuxProvincia.class));
            }
            return list;
        } catch (Exception e) {
            log.error("DUX - Error parseando provincias: {}", e.getMessage());
            return List.of();
        }
    }

    /**
     * Lista todas las localidades de una provincia. Respuesta DUX:
     * {@code { "paging": {...}, "localidades": [...] }}, paginada (default 20/req).
     * Acá iteramos hasta agotar el total. Cada página gasta 1 cuota del rate limit.
     * Doc: https://duxsoftware.readme.io/reference/consultar-localidades
     */
    /**
     * Descarga las localidades de una provincia específica.
     * Doc: https://duxsoftware.readme.io/reference/consultar-localidades
     *
     * Query params soportados: idLocalidad, idProvincia, codPostal, localidad,
     * offset, limit. Notación camelCase. Cap: limit ≤ 50.
     *
     * Aviso: nombrar mal el parámetro (ej. snake_case `id_provincia`) NO devuelve
     * error — DUX ignora el unknown y devuelve TODAS las localidades del país,
     * lo que parece "que el filtro está roto". Con `idProvincia` correcto sí filtra.
     */
    public List<DuxLocalidad> obtenerLocalidadesPorProvincia(
            long idProvincia,
            Consumer<List<DuxLocalidad>> onPagina) {
        verificarTokens();
        int limit = 50;
        int offset = 0;
        int total = Integer.MAX_VALUE;
        int vacios = 0;
        List<DuxLocalidad> all = new ArrayList<>();
        boolean primeraPagina = true;

        while (offset < total) {
            String uri = "/localidades?idProvincia=" + idProvincia
                    + "&offset=" + offset + "&limit=" + limit;
            String response = retryHandler.get(uri, tokens.token, String.class);
            if (response == null) break;
            try {
                JsonNode root = objectMapper.readTree(response);
                JsonNode paging = root.path("paging");
                if (paging.has("total")) {
                    int t = paging.get("total").asInt();
                    if (t > 0) total = t;
                }
                JsonNode arr = root.path("localidades");
                if (primeraPagina) {
                    primeraPagina = false;
                    log.info("DUX /localidades?idProvincia={} — paging.total={}, primera página {} items",
                            idProvincia,
                            total == Integer.MAX_VALUE ? "?" : total,
                            arr.isArray() ? arr.size() : -1);
                }
                if (!arr.isArray() || arr.isEmpty()) {
                    if (++vacios >= MAX_INTENTOS_VACIOS) break;
                    offset += limit;
                    continue;
                }
                vacios = 0;
                List<DuxLocalidad> pagina = new ArrayList<>(arr.size());
                for (JsonNode n : arr) {
                    DuxLocalidad d = objectMapper.treeToValue(n, DuxLocalidad.class);
                    all.add(d);
                    pagina.add(d);
                }
                if (onPagina != null) {
                    try {
                        onPagina.accept(pagina);
                    } catch (Exception ex) {
                        // El caller decide qué hacer en error de persistencia. Si falla, abortamos
                        // la paginación entera para no mantener estados inconsistentes.
                        log.error("Callback de página falló: {}. Abortando paginación.", ex.getMessage());
                        throw ex;
                    }
                }
                // Progreso paginado en DEBUG por las mismas razones que el sync de items.
                log.debug("DUX localidades idProvincia={} - {}/{}", idProvincia, all.size(), total);
                offset += limit;
                if (all.size() >= total) break;
            } catch (RuntimeException e) {
                throw e;
            } catch (Exception e) {
                log.error("DUX - Error parseando localidades offset={}: {}", offset, e.getMessage());
                break;
            }
        }
        log.info("DUX - {} localidades descargadas para idProvincia={} (FIN)", all.size(), idProvincia);
        return all;
    }

    // =====================================================
    // PEDIDOS (single write op del sistema)
    // =====================================================

    /**
     * Crea un pedido en DUX vía POST /pedido/nuevopedido.
     * Retorna la respuesta cruda (JSON) para que el caller la registre.
     *
     * Doc: https://duxsoftware.readme.io/reference/crear-pedido
     */
    public String crearPedido(String jsonBody) {
        verificarTokens();
        // HIGH: operación crítica del operador — nunca debe esperar a que termine
        // el sync de catálogo (~15 min) ni quedar atrás de páginas en cola.
        return retryHandler.postJson("/pedido/nuevopedido", tokens.token, jsonBody, null, true);
    }

    /**
     * GET crudo a cualquier path de DUX usando los tokens y el rate limiter.
     * Para uso de debug — explorar endpoints sin exponer el token en shell history.
     */
    public String rawGet(String path) {
        verificarTokens();
        if (path == null || path.isBlank()) return null;
        String uri = path.startsWith("/") ? path : "/" + path;
        return retryHandler.get(uri, tokens.token, String.class);
    }

    // =====================================================
    // TOKENS
    // =====================================================

    private void verificarTokens() {
        if (!isConfigured()) {
            cargarTokens();
            if (!isConfigured()) {
                throw new ServiceNotConfiguredException("DUX",
                        "No hay tokens. Crear " + secretsDir + "/dux_tokens.json con {\"token\":\"...\"}");
            }
        }
    }

    private void cargarTokens() {
        try {
            File file = Paths.get(secretsDir).resolve("dux_tokens.json").toFile();
            if (file.exists()) {
                tokens = objectMapper.readValue(file, TokensDux.class);
                log.info("DUX - Tokens cargados desde {}", file.getAbsolutePath());
            } else {
                log.warn("DUX - Archivo de tokens no encontrado: {}", file.getAbsolutePath());
            }
        } catch (Exception e) {
            log.error("DUX - Error cargando tokens: {}", e.getMessage());
        }
    }
}
