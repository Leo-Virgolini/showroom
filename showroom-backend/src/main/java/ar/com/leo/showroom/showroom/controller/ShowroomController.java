package ar.com.leo.showroom.showroom.controller;

import ar.com.leo.showroom.carrito.CarritoService;
import ar.com.leo.showroom.catalogo.repository.ProductoCacheRepository;
import ar.com.leo.showroom.catalogo.service.CatalogoSyncService;
import ar.com.leo.showroom.catalogo.service.ImagenLocalService;
import ar.com.leo.showroom.catalogo.service.UbicacionService;
import ar.com.leo.showroom.common.exception.NotFoundException;
import ar.com.leo.showroom.dux.service.DuxClient;
import ar.com.leo.showroom.events.SyncEventService;
import ar.com.leo.showroom.pedido.entity.EstadoPedido;
import ar.com.leo.showroom.pedido.entity.PedidoShowroom;
import ar.com.leo.showroom.pedido.repository.PedidoShowroomRepository;
import ar.com.leo.showroom.picking.PickingEmailService;
import ar.com.leo.showroom.picking.PickingExcelGenerator;
import ar.com.leo.showroom.picking.PresupuestoPdfGenerator;
import ar.com.leo.showroom.pickit_externo.PickitExternoService;
import ar.com.leo.showroom.showroom.dto.AnularPedidoRequestDTO;
import ar.com.leo.showroom.showroom.dto.CantidadRequestDTO;
import ar.com.leo.showroom.showroom.dto.CarritoAgregarRequestDTO;
import ar.com.leo.showroom.showroom.dto.CarritoAgregarResponseDTO;
import ar.com.leo.showroom.showroom.dto.CarritoStateDTO;
import ar.com.leo.showroom.showroom.dto.CatalogoItemDTO;
import ar.com.leo.showroom.showroom.dto.CatalogoPageDTO;
import ar.com.leo.showroom.showroom.dto.CrearPedidoRequestDTO;
import ar.com.leo.showroom.showroom.dto.CrearPedidoResponseDTO;
import ar.com.leo.showroom.showroom.dto.EscalaDescuentoDTO;
import ar.com.leo.showroom.showroom.dto.HorarioSyncDTO;
import ar.com.leo.showroom.showroom.dto.LocalidadDTO;
import ar.com.leo.showroom.showroom.dto.PedidoDetailDTO;
import ar.com.leo.showroom.showroom.dto.PedidoListPageDTO;
import ar.com.leo.showroom.showroom.dto.PickingEmailConfigDTO;
import ar.com.leo.showroom.showroom.dto.PickitConfigDTO;
import ar.com.leo.showroom.showroom.dto.ProductoListPageDTO;
import ar.com.leo.showroom.showroom.dto.ProvinciaDTO;
import ar.com.leo.showroom.showroom.dto.ScanResultDTO;
import ar.com.leo.showroom.showroom.dto.SkusRequestDTO;
import ar.com.leo.showroom.showroom.service.ShowroomService;
import ar.com.leo.showroom.visor.VisorService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.time.Duration;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/showroom")
@RequiredArgsConstructor
public class ShowroomController {

    private final ShowroomService service;
    private final CarritoService carritoService;
    private final CatalogoSyncService catalogoSync;
    private final DuxClient duxClient;
    private final SyncEventService eventService;
    private final ProductoCacheRepository productoCacheRepository;
    private final UbicacionService ubicacionService;
    private final PedidoShowroomRepository pedidoRepository;
    private final PickingExcelGenerator excelGenerator;
    private final PresupuestoPdfGenerator pdfGenerator;
    private final PickingEmailService pickingEmailService;
    private final PickitExternoService pickitExternoService;
    private final ImagenLocalService imagenLocalService;
    private final VisorService visorService;

    private static final MediaType XLSX = MediaType.parseMediaType(
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");

    /**
     * Lookup rápido por SKU desde el cache local.
     * Si no está en cache, hace 1 request a DUX (rate-limited).
     *
     * <p>El resultado también se publica al visor (SSE {@code scan-visor})
     * para que las pantallas en {@code /visor} (típicamente celulares de
     * clientes) muestren el producto en tiempo real.
     */
    @GetMapping("/scan/{sku}")
    public ScanResultDTO scan(@PathVariable String sku) {
        ScanResultDTO result = service.scan(sku);
        visorService.publicarScan(result);
        return result;
    }

    /**
     * Disparado desde {@code /visor}: el cliente agregó un producto al carrito
     * desde el celular. Pasa por el {@link CarritoService} igual que el endpoint
     * del operador — el carrito es único global, así que el item aparece en la
     * pantalla del operador automáticamente vía SSE {@code carrito-updated}.
     *
     * <p>El response incluye cuánto se agregó realmente (puede ser menor a lo
     * pedido si el carrito ya estaba al tope por stock). El visor muestra esa
     * cantidad real al cliente, no la pedida.
     *
     * <p>Endpoint público (el visor no tiene sesión).
     */
    @PostMapping("/visor/agregar-carrito")
    public CarritoAgregarResponseDTO visorAgregarAlCarrito(@RequestBody @Valid CarritoAgregarRequestDTO request) {
        return carritoService.agregar(request.sku(), request.cantidad(), CarritoStateDTO.Origen.VISOR);
    }

    // =====================================================
    // Carrito (operador, autenticado). Es el mismo carrito que toca el visor —
    // único global y broadcasteado por SSE {@code carrito-updated}.
    // =====================================================

    @GetMapping("/carrito")
    public CarritoStateDTO obtenerCarrito() {
        return carritoService.obtener();
    }

    @PostMapping("/carrito/items")
    public CarritoAgregarResponseDTO agregarItemCarrito(@RequestBody @Valid CarritoAgregarRequestDTO request) {
        return carritoService.agregar(request.sku(), request.cantidad(), CarritoStateDTO.Origen.OPERADOR);
    }

    @PatchMapping("/carrito/items/{sku}")
    public CarritoStateDTO actualizarCantidadItemCarrito(
            @PathVariable String sku,
            @RequestBody @Valid CantidadRequestDTO request) {
        return carritoService.actualizarCantidad(sku, request.cantidad());
    }

    @DeleteMapping("/carrito/items/{sku}")
    public CarritoStateDTO eliminarItemCarrito(@PathVariable String sku) {
        return carritoService.eliminar(sku);
    }

    @DeleteMapping("/carrito")
    public CarritoStateDTO vaciarCarrito() {
        return carritoService.vaciar(CarritoStateDTO.Origen.OPERADOR);
    }

    @PostMapping("/carrito/refresh-stock")
    public CarritoStateDTO refrescarStockCarrito() {
        return carritoService.refrescarStock();
    }

    /**
     * Refresca on-demand stock + precios para una lista de SKUs.
     * Cada SKU consume 1 request DUX (~7s). Recomendado antes de cerrar pedido.
     */
    @PostMapping("/refresh-stock")
    public List<ScanResultDTO> refreshStock(@RequestBody @Valid SkusRequestDTO request) {
        return service.refrescarStock(request.skus());
    }

    /**
     * Búsqueda paginada en el catálogo local. Para la pantalla de etiquetas QR.
     */
    @GetMapping("/catalogo")
    public CatalogoPageDTO buscarCatalogo(
            @RequestParam(value = "q", required = false) String q,
            @RequestParam(value = "page", defaultValue = "0") int page,
            @RequestParam(value = "size", defaultValue = "50") int size) {
        return service.buscarCatalogo(q, page, size);
    }

    /**
     * Lookup bulk en el cache local (sin DUX). Devuelve solo los SKUs encontrados.
     */
    @PostMapping("/lookup")
    public List<CatalogoItemDTO> lookup(@RequestBody @Valid SkusRequestDTO request) {
        return service.lookup(request.skus());
    }

    /**
     * Reindexa la carpeta de imágenes inmediatamente. Disparar después de subir
     * imágenes nuevas para que aparezcan sin reiniciar el backend.
     */
    @PostMapping("/imagenes/reindex")
    public Map<String, Object> reindexarImagenes() {
        imagenLocalService.recargarIndice();
        return Map.of(
                "message", "Índice de imágenes recargado",
                "totalArchivos", imagenLocalService.getTotalArchivos());
    }

    /**
     * Sirve la imagen de un producto desde la carpeta local configurada en
     * {@code showroom.presupuesto.imagenes-folder}. Busca {sku}.{jpg|jpeg|png|webp|gif|bmp}.
     * Si no existe, devuelve 404 (el frontend muestra placeholder via onError).
     * Headers de cache largos para que el browser no la pida en cada render.
     */
    @GetMapping("/productos/{sku}/imagen")
    public ResponseEntity<Resource> obtenerImagenProducto(@PathVariable String sku) {
        return imagenLocalService.buscar(sku)
                .<ResponseEntity<Resource>>map(file -> ResponseEntity.ok()
                        .contentType(mediaTypeFor(file.getName()))
                        .cacheControl(CacheControl.maxAge(Duration.ofDays(7)).cachePublic())
                        .body(new FileSystemResource(file)))
                .orElseGet(() -> ResponseEntity.notFound()
                        .cacheControl(CacheControl.maxAge(Duration.ofMinutes(5)).cachePublic())
                        .build());
    }

    private static MediaType mediaTypeFor(String filename) {
        String lower = filename.toLowerCase();
        if (lower.endsWith(".png")) return MediaType.IMAGE_PNG;
        if (lower.endsWith(".gif")) return MediaType.IMAGE_GIF;
        if (lower.endsWith(".webp")) return MediaType.parseMediaType("image/webp");
        if (lower.endsWith(".bmp")) return MediaType.parseMediaType("image/bmp");
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return MediaType.IMAGE_JPEG;
        // Fallback — pedirle al SO que lo deduzca (cubre tiff, heic, avif, etc.)
        try {
            String type = java.nio.file.Files.probeContentType(java.nio.file.Path.of(filename));
            if (type != null) return MediaType.parseMediaType(type);
        } catch (Exception ignored) {
            // si falla, octet-stream es un fallback razonable
        }
        return MediaType.APPLICATION_OCTET_STREAM;
    }

    /**
     * Listado paginado del cache con filtros — pantalla read-only de productos.
     * Devuelve campos enriquecidos (stock, precio c/IVA, sincronizadoAt) que
     * `/catalogo` omite.
     */
    @GetMapping("/productos")
    public ProductoListPageDTO listarProductos(
            @RequestParam(value = "q", required = false) String q,
            @RequestParam(value = "soloDeshabilitados", defaultValue = "false") boolean soloDeshabilitados,
            @RequestParam(value = "soloSinStock", defaultValue = "false") boolean soloSinStock,
            @RequestParam(value = "page", defaultValue = "0") int page,
            @RequestParam(value = "size", defaultValue = "50") int size,
            @RequestParam(value = "sortField", required = false) String sortField,
            @RequestParam(value = "sortOrder", required = false) String sortOrder) {
        return service.buscarProductos(q, soloDeshabilitados, soloSinStock, page, size, sortField, sortOrder);
    }

    /**
     * Listado paginado de pedidos locales con filtros — pantalla `/pedidos`.
     */
    @GetMapping("/pedidos")
    public PedidoListPageDTO listarPedidos(
            @RequestParam(value = "q", required = false) String q,
            @RequestParam(value = "estado", required = false) EstadoPedido estado,
            @RequestParam(value = "desde", required = false) Instant desde,
            @RequestParam(value = "hasta", required = false) Instant hasta,
            @RequestParam(value = "page", defaultValue = "0") int page,
            @RequestParam(value = "size", defaultValue = "50") int size,
            @RequestParam(value = "sortField", required = false) String sortField,
            @RequestParam(value = "sortOrder", required = false) String sortOrder) {
        return service.listarPedidos(q, estado, desde, hasta, page, size, sortField, sortOrder);
    }

    /**
     * Detalle completo de un pedido (items + respuesta cruda de DUX).
     */
    @GetMapping("/pedidos/{id}")
    public PedidoDetailDTO obtenerPedido(@PathVariable Long id) {
        return service.obtenerPedido(id);
    }

    /**
     * Descarga el XLSX de picking (SKU + cantidad) — el mismo que se manda por email.
     */
    @GetMapping("/pedidos/{id}/excel")
    public ResponseEntity<byte[]> descargarExcelPedido(@PathVariable Long id) {
        PedidoShowroom pedido = pedidoRepository.findById(id)
                .orElseThrow(() -> new NotFoundException("Pedido no encontrado: " + id));
        byte[] body = excelGenerator.generar(pedido);
        return ResponseEntity.ok()
                .contentType(XLSX)
                .header(HttpHeaders.CONTENT_DISPOSITION,
                        "attachment; filename=\"" + excelGenerator.nombreArchivo(pedido) + "\"")
                .header(HttpHeaders.ACCESS_CONTROL_EXPOSE_HEADERS, HttpHeaders.CONTENT_DISPOSITION)
                .body(body);
    }

    /**
     * Descarga el presupuesto PDF (look-and-feel KT GASTRO) — el mismo que se manda por email.
     */
    @GetMapping("/pedidos/{id}/pdf")
    public ResponseEntity<byte[]> descargarPdfPedido(@PathVariable Long id) {
        PedidoShowroom pedido = pedidoRepository.findById(id)
                .orElseThrow(() -> new NotFoundException("Pedido no encontrado: " + id));
        byte[] body = pdfGenerator.generar(pedido);
        return ResponseEntity.ok()
                .contentType(MediaType.APPLICATION_PDF)
                .header(HttpHeaders.CONTENT_DISPOSITION,
                        "attachment; filename=\"" + pdfGenerator.nombreArchivo(pedido) + "\"")
                .header(HttpHeaders.ACCESS_CONTROL_EXPOSE_HEADERS, HttpHeaders.CONTENT_DISPOSITION)
                .body(body);
    }

    /**
     * Anula un pedido (acción manual del operador). Marca estado=ANULADO,
     * registra timestamp y motivo opcional. NO cancela en DUX — la API de DUX
     * no expone esa operación; si el pedido ya estaba CARGADO_EN_DUX hay que
     * cancelarlo manualmente desde la UI de DUX.
     *
     * Devuelve el detalle del pedido ya con estado ANULADO. 409 si ya estaba.
     */
    @PostMapping("/pedidos/{id}/anular")
    public PedidoDetailDTO anularPedido(
            @PathVariable Long id,
            @RequestBody(required = false) @Valid AnularPedidoRequestDTO body) {
        String motivo = body != null ? body.motivo() : null;
        return service.anularPedido(id, motivo);
    }

    /**
     * Re-envía manualmente el email de picking (XLSX + PDF) para un pedido ya
     * existente. El envío es async — la respuesta HTTP solo confirma que se
     * encoló; el resultado real llega vía SSE picking-email (toast en el frontend).
     */
    @PostMapping("/pedidos/{id}/email")
    public ResponseEntity<Map<String, Object>> reenviarEmailPedido(@PathVariable Long id) {
        // findByIdWithItems hidrata los items en la misma query — los necesita
        // el thread @Async, donde la sesión Hibernate ya está cerrada.
        PedidoShowroom pedido = pedidoRepository.findByIdWithItems(id)
                .orElseThrow(() -> new NotFoundException("Pedido no encontrado: " + id));
        return pickingEmailService.motivoNoConfigurado()
                .<ResponseEntity<Map<String, Object>>>map(motivo -> ResponseEntity
                        .status(HttpStatus.SERVICE_UNAVAILABLE)
                        .body(Map.of("error", motivo)))
                .orElseGet(() -> {
                    pickingEmailService.enviarAsync(pedido);
                    return ResponseEntity.accepted().body(Map.of(
                            "message", "Envío encolado — el toast confirmará cuando salga.",
                            "pedidoId", pedido.getId()));
                });
    }

    /**
     * Regenera el pickit externo (programa pickit-y-etiquetas) para un pedido
     * ya creado. Async — el resultado llega vía SSE {@code pickit-externo}.
     * 503 si la integración no está configurada (jar faltante, paths incompletos).
     */
    @PostMapping("/pedidos/{id}/pickit-externo")
    public ResponseEntity<Map<String, Object>> regenerarPickitExterno(@PathVariable Long id) {
        // findByIdWithItems hidrata los items en la misma query — los necesita
        // el thread @Async para escribir el .xlsx de input al programa pickit.
        PedidoShowroom pedido = pedidoRepository.findByIdWithItems(id)
                .orElseThrow(() -> new NotFoundException("Pedido no encontrado: " + id));
        return pickitExternoService.motivoNoConfigurado()
                .<ResponseEntity<Map<String, Object>>>map(motivo -> ResponseEntity
                        .status(HttpStatus.SERVICE_UNAVAILABLE)
                        .body(Map.of("error", motivo)))
                .orElseGet(() -> {
                    pickitExternoService.generarAsync(pedido);
                    return ResponseEntity.accepted().body(Map.of(
                            "message", "Pickit externo encolado — el toast confirmará el path generado.",
                            "pedidoId", pedido.getId()));
                });
    }

    /**
     * Descarga un .xlsx pickit generado por el programa externo. El path llega
     * como query param (lo provee el SSE {@code pickit-externo}). Se valida que
     * apunte dentro del {@code outputDir} configurado para prevenir path
     * traversal — sino cualquiera podría leer arbitrariamente archivos del
     * container con un GET autenticado.
     */
    @GetMapping("/pickit-externo/descargar")
    public ResponseEntity<Resource> descargarPickitExterno(@RequestParam("path") String path) {
        PickitConfigDTO cfg = service.getPickitConfig();
        if (!cfg.enabled() || cfg.outputDir() == null || cfg.outputDir().isBlank()) {
            return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE).build();
        }
        java.nio.file.Path solicitado = java.nio.file.Path.of(path).toAbsolutePath().normalize();
        java.nio.file.Path permitido = java.nio.file.Path.of(cfg.outputDir()).toAbsolutePath().normalize();
        if (!solicitado.startsWith(permitido)) {
            // Intento de path traversal o path fuera del outputDir configurado.
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        }
        if (!java.nio.file.Files.isRegularFile(solicitado)) {
            return ResponseEntity.notFound().build();
        }
        return ResponseEntity.ok()
                .contentType(XLSX)
                .header(HttpHeaders.CONTENT_DISPOSITION,
                        "attachment; filename=\"" + solicitado.getFileName().toString() + "\"")
                .header(HttpHeaders.ACCESS_CONTROL_EXPOSE_HEADERS, HttpHeaders.CONTENT_DISPOSITION)
                .body(new FileSystemResource(solicitado.toFile()));
    }

    /**
     * Crea un pedido en DUX a partir del carrito.
     */
    @PostMapping("/pedido-dux")
    public ResponseEntity<CrearPedidoResponseDTO> crearPedido(
            @RequestBody @Valid CrearPedidoRequestDTO request) {
        CrearPedidoResponseDTO response = service.crearPedido(request);
        HttpStatus status = response.estado() == EstadoPedido.ENVIADO
                ? HttpStatus.CREATED
                : HttpStatus.ACCEPTED; // 202 si quedó local pero DUX falló
        return ResponseEntity.status(status).body(response);
    }

    /**
     * Dispara sincronización del catálogo desde DUX.
     * Por default es incremental (rápido); con ?force=true descarga TODO el
     * catálogo (~15 minutos por el rate limit de DUX) — útil para resetear el cache.
     */
    @PostMapping("/sync-catalogo")
    public ResponseEntity<Map<String, Object>> sincronizarCatalogo(
            @RequestParam(value = "force", defaultValue = "false") boolean force) {
        if (catalogoSync.isSyncEnCurso()) {
            return ResponseEntity.status(HttpStatus.CONFLICT)
                    .body(Map.of("message", "Ya hay un sync en curso"));
        }
        catalogoSync.sincronizarCatalogoCompletoAsync(force);
        return ResponseEntity.accepted().body(Map.of(
                "message", force ? "Sync completo iniciado en background" : "Sync iniciado en background",
                "force", force));
    }

    /**
     * Cancela el sync en curso. La cancelación es cooperativa — el flag se chequea
     * entre páginas de DUX, así que toma efecto en hasta ~7s (request en vuelo).
     * Los items ya bajados se persisten (sync queda parcial pero no se pierde).
     */
    @PostMapping("/sync-catalogo/cancelar")
    public ResponseEntity<Map<String, Object>> cancelarSync() {
        boolean cancelado = catalogoSync.cancelarSync();
        if (!cancelado) {
            return ResponseEntity.status(HttpStatus.CONFLICT)
                    .body(Map.of("message", "No hay un sync en curso para cancelar"));
        }
        return ResponseEntity.accepted().body(Map.of(
                "message", "Cancelación solicitada — el sync va a abortar entre las próximas páginas"));
    }

    /** id_pais de Argentina en DUX. La lista global incluye también Uruguay (4), etc. */
    private static final long ID_PAIS_ARGENTINA = 1L;

    /**
     * Lista de provincias de Argentina persistidas en la BD (descargadas una vez desde DUX).
     * Ajustes de presentación: a CABA se le suma " (CABA)" al nombre para que
     * sea encontrable buscando "caba". Buenos Aires y CABA se anclan arriba
     * (son las más usadas en el showroom); el resto en orden alfabético.
     */
    @GetMapping("/provincias")
    public List<ProvinciaDTO> listarProvincias() {
        return ubicacionService.listarProvincias().stream()
                .filter(p -> Long.valueOf(ID_PAIS_ARGENTINA).equals(p.getIdPais()))
                .map(p -> new ProvinciaDTO(
                        p.getCodIso(),
                        "C".equalsIgnoreCase(p.getCodIso())
                                ? p.getNombre() + " (CABA)"
                                : p.getNombre()))
                .sorted((a, b) -> {
                    int prioA = prioridadProvincia(a.codigo());
                    int prioB = prioridadProvincia(b.codigo());
                    if (prioA != prioB) return Integer.compare(prioA, prioB);
                    return a.nombre().compareTo(b.nombre());
                })
                .toList();
    }

    private static int prioridadProvincia(String codIso) {
        if ("B".equalsIgnoreCase(codIso)) return 0;
        if ("C".equalsIgnoreCase(codIso)) return 1;
        return 2;
    }

    /**
     * Localidades de una provincia persistidas en la BD. La primera vez que
     * el operador elige una provincia que no es Buenos Aires, se descargan en
     * el momento (puede tardar varios segundos por el rate limit DUX).
     */
    @GetMapping("/localidades")
    public List<LocalidadDTO> listarLocalidades(
            @RequestParam(value = "codigoProvincia") String codigoProvincia) {
        return ubicacionService.listarLocalidadesPorCodIso(codigoProvincia).stream()
                .map(l -> new LocalidadDTO(String.valueOf(l.getId()), l.getNombre(), codigoProvincia))
                .toList();
    }

    /**
     * Debug: GET crudo a cualquier path de DUX usando los tokens del backend.
     * Devuelve la respuesta tal cual la manda DUX. Útil para explorar endpoints
     * sin exponer el token en curl. Ej: `GET /api/showroom/debug/dux-get?path=/percepcionesImpuestos`.
     */
    @GetMapping(value = "/debug/dux-get", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<String> debugDuxGet(@RequestParam("path") String path) {
        String body = duxClient.rawGet(path);
        return ResponseEntity.ok(body);
    }

    /**
     * Escalones de descuento configurados (umbral subtotal s/IVA → % a aplicar).
     * El frontend los lee al iniciar para que las pantallas de scan y carrito
     * usen los mismos umbrales/porcentajes que el backend persiste.
     */
    @GetMapping("/config/escalas-descuento")
    public List<EscalaDescuentoDTO> listarEscalasDescuento() {
        return service.listarEscalasDescuento();
    }

    /**
     * Reemplaza la lista completa de escalones (operación atómica). El payload
     * es la nueva lista entera; el backend valida (umbrales positivos,
     * porcentajes 0..100, sin duplicados) y devuelve la lista actualizada.
     * 400 si alguna validación falla.
     */
    @PutMapping("/config/escalas-descuento")
    public List<EscalaDescuentoDTO> actualizarEscalasDescuento(
            @RequestBody List<EscalaDescuentoDTO> nuevas) {
        return service.reemplazarEscalasDescuento(nuevas);
    }

    /**
     * Horarios diarios de sincronización automática con DUX (zona AR).
     * Si la lista está vacía, no hay sync automática — solo manual.
     */
    @GetMapping("/config/horarios-sync")
    public List<HorarioSyncDTO> listarHorariosSync() {
        return service.listarHorariosSync();
    }

    /**
     * Reemplaza la lista completa de horarios (operación atómica). El backend
     * valida (hora 0..23, minuto 0..59, sin duplicados), persiste y reprograma
     * los disparos. 400 si alguna validación falla.
     */
    @PutMapping("/config/horarios-sync")
    public List<HorarioSyncDTO> actualizarHorariosSync(
            @RequestBody List<HorarioSyncDTO> nuevos) {
        return service.reemplazarHorariosSync(nuevos);
    }

    /**
     * Destinatario del email de picking. Acepta uno o varios mails separados
     * por coma. Persiste en BD — los cambios se aplican en el próximo envío
     * sin reiniciar el backend.
     */
    @GetMapping("/config/picking-email")
    public PickingEmailConfigDTO obtenerEmailPicking() {
        return new PickingEmailConfigDTO(service.getEmailPicking());
    }

    /**
     * Actualiza el destinatario del email de picking. Pasar email vacío vuelve
     * al default de application.properties (deshabilita el envío si tampoco
     * hay default). 400 si el formato es inválido.
     */
    @PutMapping("/config/picking-email")
    public PickingEmailConfigDTO actualizarEmailPicking(@RequestBody PickingEmailConfigDTO body) {
        return new PickingEmailConfigDTO(service.setEmailPicking(body.email()));
    }

    /**
     * Configuración de la integración con el programa pickit-y-etiquetas (jar
     * nativo en el host, ejecutado por el backend vía ProcessBuilder).
     */
    @GetMapping("/config/pickit")
    public PickitConfigDTO obtenerPickitConfig() {
        return service.getPickitConfig();
    }

    @PutMapping("/config/pickit")
    public PickitConfigDTO actualizarPickitConfig(@RequestBody PickitConfigDTO body) {
        return service.savePickitConfig(body);
    }

    @GetMapping("/health")
    public Map<String, Object> health() {
        Map<String, Object> body = new HashMap<>();
        body.put("duxConfigurado", duxClient.isConfigured());
        body.put("syncEnCurso", catalogoSync.isSyncEnCurso());
        body.put("listaPrecios", duxClient.getProperties().listaPreciosNombre());
        body.put("totalProductos", productoCacheRepository.count());
        // Solo presente si hay un sync corriendo — el frontend lo usa para mostrar
        // "Sincronizando desde HH:mm" cuando un cliente se conecta tarde.
        catalogoSync.getSyncIniciadoAt().ifPresent(t -> body.put("syncIniciadoAt", t));
        // Cuándo terminó la última sync global exitosa (sync_metadata.ultima_sync_global_at).
        // Si nunca corrió una sync exitosa, queda ausente y el frontend oculta el banner.
        // No usamos MAX(producto_cache.sincronizado_at) porque se contamina con
        // refreshes individuales y con items persistidos por syncs cancelados.
        catalogoSync.getUltimaSyncGlobalAt()
                .ifPresent(t -> body.put("ultimaSincronizacionAt", t));
        return body;
    }

    /**
     * Stream Server-Sent Events. Los clientes abren un EventSource y reciben
     * eventos en tiempo real (sync started/completed/failed). El browser hace
     * reconnect automático si la conexión se cae.
     */
    @GetMapping(value = "/events", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter events() {
        return eventService.subscribe();
    }
}
