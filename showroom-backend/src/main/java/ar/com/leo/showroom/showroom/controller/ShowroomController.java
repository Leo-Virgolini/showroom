package ar.com.leo.showroom.showroom.controller;

import ar.com.leo.showroom.carrito.CarritoService;
import ar.com.leo.showroom.catalogo.repository.ProductoCacheRepository;
import ar.com.leo.showroom.catalogo.service.CatalogoSyncService;
import ar.com.leo.showroom.catalogo.service.ImagenLocalService;
import ar.com.leo.showroom.catalogo.service.UbicacionService;
import ar.com.leo.showroom.common.exception.ConflictException;
import ar.com.leo.showroom.common.exception.NotFoundException;
import ar.com.leo.showroom.dux.service.DuxClient;
import ar.com.leo.showroom.events.SyncEventService;
import ar.com.leo.showroom.pedido.entity.EstadoPedido;
import ar.com.leo.showroom.pedido.entity.PedidoShowroom;
import ar.com.leo.showroom.pedido.repository.PedidoShowroomRepository;
import ar.com.leo.showroom.config.service.FormaPagoService;
import ar.com.leo.showroom.config.service.PerfilEtiquetasService;
import ar.com.leo.showroom.picking.PickingEmailService;
import ar.com.leo.showroom.picking.WhatsappBusinessService;
import ar.com.leo.showroom.picking.PresupuestoPdfGenerator;
import ar.com.leo.showroom.pickit_externo.PickitExternoService;
import ar.com.leo.showroom.presupuesto.dto.EnviarPresupuestoRequestDTO;
import ar.com.leo.showroom.presupuesto.dto.GenerarPresupuestoRequestDTO;
import ar.com.leo.showroom.presupuesto.service.PresupuestoComercialService;
import ar.com.leo.showroom.sesion.dto.IniciarSesionRequestDTO;
import ar.com.leo.showroom.sesion.dto.SesionDetalleDTO;
import ar.com.leo.showroom.sesion.dto.SesionEnvioEmailRequestDTO;
import ar.com.leo.showroom.sesion.dto.SesionEnvioWhatsappRequestDTO;
import ar.com.leo.showroom.sesion.dto.SesionListPageDTO;
import ar.com.leo.showroom.showroom.dto.EstadisticasHistorialDTO;
import ar.com.leo.showroom.sesion.dto.SesionShowroomDTO;
import ar.com.leo.showroom.sesion.entity.SesionShowroom;
import ar.com.leo.showroom.sesion.repository.SesionShowroomRepository;
import ar.com.leo.showroom.sesion.service.SesionShowroomService;
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
import ar.com.leo.showroom.showroom.dto.FormaPagoDTO;
import ar.com.leo.showroom.showroom.dto.PerfilEtiquetasDTO;
import ar.com.leo.showroom.showroom.dto.HorarioSyncDTO;
import ar.com.leo.showroom.showroom.dto.NotificacionesAutoConfigDTO;
import ar.com.leo.showroom.showroom.dto.LocalidadDTO;
import ar.com.leo.showroom.showroom.dto.PedidoDetailDTO;
import ar.com.leo.showroom.showroom.dto.PedidoListPageDTO;
import ar.com.leo.showroom.showroom.dto.PickitConfigDTO;
import ar.com.leo.showroom.showroom.dto.ProductoListPageDTO;
import ar.com.leo.showroom.showroom.dto.ProvinciaDTO;
import ar.com.leo.showroom.showroom.dto.ScanResultDTO;
import ar.com.leo.showroom.showroom.dto.SkusRequestDTO;
import ar.com.leo.showroom.showroom.dto.WhatsappMensajeConfigDTO;
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
    private final PresupuestoPdfGenerator pdfGenerator;
    private final PickingEmailService pickingEmailService;
    private final WhatsappBusinessService whatsappBusinessService;
    private final FormaPagoService formaPagoService;
    private final PerfilEtiquetasService perfilEtiquetasService;
    private final PickitExternoService pickitExternoService;
    private final ImagenLocalService imagenLocalService;
    private final VisorService visorService;
    private final SesionShowroomService sesionShowroomService;
    private final SesionShowroomRepository sesionRepository;
    private final PresupuestoComercialService presupuestoComercialService;

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
        try {
            ScanResultDTO result = service.scan(sku);
            visorService.publicarScan(result);
            // Registrar en la sesión activa si la hay. No bloquea el flujo si
            // no hay sesión (operador no inició una) — el registro es best-effort.
            sesionShowroomService.registrarScan(result);
            return result;
        } catch (NotFoundException e) {
            // El código no existe ni en cache ni en DUX. Publicamos al visor
            // para que el cliente no se confunda viendo el último producto
            // válido en pantalla. Re-lanzamos para que el operador siga
            // viendo el 404 + toast en su pantalla.
            visorService.publicarScanFallido(sku);
            throw e;
        }
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
     *
     * <p>Rechaza con 409 si no hay sesión de atención activa: el carrito tiene
     * sentido solo cuando el operador está atendiendo a un cliente. Sin esta
     * validación, cualquiera con la URL del visor podría agregar items al carrito
     * fuera del horario de atención, o cuando el operador no le inició la sesión.
     */
    @PostMapping("/visor/agregar-carrito")
    public CarritoAgregarResponseDTO visorAgregarAlCarrito(@RequestBody @Valid CarritoAgregarRequestDTO request) {
        if (sesionShowroomService.obtenerActiva().id() == null) {
            throw new ConflictException(
                    "No hay una sesión de atención activa — el operador todavía no te asoció. Avisale al vendedor.");
        }
        return carritoService.agregar(
                request.sku(), request.cantidad(), CarritoStateDTO.Origen.VISOR, request.forzarFlag());
    }

    // =====================================================
    // Sesión de atención al cliente — agrupa scans para el historial.
    // =====================================================

    /** Inicia una sesión nueva cerrando la anterior si existía. */
    @PostMapping("/sesion/iniciar")
    public SesionShowroomDTO iniciarSesion(@RequestBody @Valid IniciarSesionRequestDTO body) {
        return sesionShowroomService.iniciar(body.nombre());
    }

    /** Cancela la sesión activa (operador descartó al cliente sin pedido). */
    @PostMapping("/sesion/cancelar")
    public SesionShowroomDTO cancelarSesion() {
        return sesionShowroomService.cancelar();
    }

    /** Estado actual: la sesión activa o un placeholder inactivo. */
    @GetMapping("/sesion/activa")
    public SesionShowroomDTO sesionActiva() {
        return sesionShowroomService.obtenerActiva();
    }

    /** Listado paginado para la página /historial. */
    @GetMapping("/sesiones")
    public SesionListPageDTO listarSesiones(
            @RequestParam(value = "q", required = false) String q,
            @RequestParam(value = "desde", required = false) Instant desde,
            @RequestParam(value = "hasta", required = false) Instant hasta,
            @RequestParam(value = "page", defaultValue = "0") int page,
            @RequestParam(value = "size", defaultValue = "50") int size) {
        return sesionShowroomService.listar(q, desde, hasta, page, size);
    }

    /** Detalle expandido con los items escaneados. */
    @GetMapping("/sesiones/{id}")
    public SesionDetalleDTO obtenerSesion(@PathVariable Long id) {
        return sesionShowroomService.obtenerDetalle(id);
    }

    /**
     * Estadísticas agregadas para los charts del historial: top productos más
     * escaneados y más comprados. Filtros opcionales por rango de fechas.
     */
    @GetMapping("/historial/estadisticas")
    public EstadisticasHistorialDTO estadisticasHistorial(
            @RequestParam(value = "desde", required = false) Instant desde,
            @RequestParam(value = "hasta", required = false) Instant hasta,
            @RequestParam(value = "topN", defaultValue = "10") int topN) {
        return service.obtenerEstadisticasHistorial(desde, hasta, topN);
    }

    /**
     * Envía el PDF de productos vistos por email a un cliente cuya sesión
     * terminó SIN pedido (abandonada). El operador carga el email destinatario
     * en un dialog del historial. Async — el resultado real (SENT/FAILED) llega
     * vía SSE {@code picking-email}.
     *
     * <p>Rechaza con 503 si la integración de email no está configurada.
     */
    @PostMapping("/sesiones/{id}/email")
    public ResponseEntity<Map<String, Object>> enviarEmailSesion(
            @PathVariable Long id,
            @RequestBody @Valid SesionEnvioEmailRequestDTO body) {
        SesionShowroom sesion = sesionRepository.findByIdWithItems(id)
                .orElseThrow(() -> new NotFoundException("Sesión no encontrada: " + id));
        return pickingEmailService.motivoNoConfigurado()
                .<ResponseEntity<Map<String, Object>>>map(motivo -> ResponseEntity
                        .status(HttpStatus.SERVICE_UNAVAILABLE)
                        .body(Map.of("error", motivo)))
                .orElseGet(() -> {
                    pickingEmailService.enviarPdfSesionAsync(sesion, body.email());
                    return ResponseEntity.accepted().body(Map.of(
                            "message", "Envío encolado — el toast confirmará cuando salga.",
                            "sesionId", sesion.getId()));
                });
    }

    /**
     * Envía el PDF de productos vistos por WhatsApp a un cliente cuya sesión
     * terminó SIN pedido. Mismo flujo que el email pero por Meta Cloud API.
     * Async — el resultado real llega vía SSE {@code whatsapp-business}.
     */
    @PostMapping("/sesiones/{id}/whatsapp")
    public ResponseEntity<Map<String, Object>> enviarWhatsappSesion(
            @PathVariable Long id,
            @RequestBody @Valid SesionEnvioWhatsappRequestDTO body) {
        SesionShowroom sesion = sesionRepository.findByIdWithItems(id)
                .orElseThrow(() -> new NotFoundException("Sesión no encontrada: " + id));
        return whatsappBusinessService.motivoNoConfigurado()
                .<ResponseEntity<Map<String, Object>>>map(motivo -> ResponseEntity
                        .status(HttpStatus.SERVICE_UNAVAILABLE)
                        .body(Map.of("error", motivo)))
                .orElseGet(() -> {
                    whatsappBusinessService.enviarPdfSesionAsync(sesion, body.telefono());
                    return ResponseEntity.accepted().body(Map.of(
                            "message", "Envío encolado — el toast confirmará cuando salga.",
                            "sesionId", sesion.getId()));
                });
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
        return carritoService.agregar(
                request.sku(), request.cantidad(), CarritoStateDTO.Origen.OPERADOR, request.forzarFlag());
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
    @PostMapping("/admin/imagenes/reindex")
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
            @RequestParam(value = "id", required = false) Long id,
            @RequestParam(value = "q", required = false) String q,
            @RequestParam(value = "estado", required = false) EstadoPedido estado,
            @RequestParam(value = "desde", required = false) Instant desde,
            @RequestParam(value = "hasta", required = false) Instant hasta,
            @RequestParam(value = "page", defaultValue = "0") int page,
            @RequestParam(value = "size", defaultValue = "50") int size,
            @RequestParam(value = "sortField", required = false) String sortField,
            @RequestParam(value = "sortOrder", required = false) String sortOrder) {
        return service.listarPedidos(id, q, estado, desde, hasta, page, size, sortField, sortOrder);
    }

    /**
     * Detalle completo de un pedido (items + respuesta cruda de DUX).
     */
    @GetMapping("/pedidos/{id}")
    public PedidoDetailDTO obtenerPedido(@PathVariable Long id) {
        return service.obtenerPedido(id);
    }

    /**
     * Descarga el PDF que recibió el cliente por email — productos que vio
     * durante la sesión pero NO compró (look-and-feel KT GASTRO).
     *
     * <p>404 si:
     * <ul>
     *   <li>el pedido no existe;</li>
     *   <li>el pedido no tiene sesión asociada (operador no inició una);</li>
     *   <li>el cliente compró todo lo que vio (no hay items extra).</li>
     * </ul>
     */
    @GetMapping("/pedidos/{id}/pdf")
    public ResponseEntity<byte[]> descargarPdfPedido(@PathVariable Long id) {
        PedidoShowroom pedido = pedidoRepository.findByIdWithItems(id)
                .orElseThrow(() -> new NotFoundException("Pedido no encontrado: " + id));
        SesionShowroom sesion = sesionRepository.findByPedidoIdWithItems(id)
                .orElseThrow(() -> new NotFoundException(
                        "Este pedido no tiene sesión asociada — no hay PDF de follow-up para descargar."));
        byte[] body = pdfGenerator.generarHistorial(sesion, pedido);
        if (body == null) {
            throw new NotFoundException(
                    "El cliente compró todo lo que vio — no hay PDF de productos extra.");
        }
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
     * Revierte la anulación de un pedido. Restaura el estado previo según los
     * timestamps/respuesta_dux preservados al anular. 409 si el pedido no estaba
     * en estado ANULADO.
     */
    @PostMapping("/pedidos/{id}/reactivar")
    public PedidoDetailDTO reactivarPedido(@PathVariable Long id) {
        return service.reactivarPedido(id);
    }

    /**
     * Re-envía manualmente el email del presupuesto (PDF) para un pedido ya
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
     * Re-envía manualmente el PDF del presupuesto por WhatsApp para un pedido
     * ya existente. El envío es async — la respuesta solo confirma que se
     * encoló; el resultado real (SENT / WINDOW_CLOSED / FAILED) llega vía SSE
     * {@code whatsapp-business}.
     */
    @PostMapping("/pedidos/{id}/whatsapp")
    public ResponseEntity<Map<String, Object>> reenviarWhatsappPedido(@PathVariable Long id) {
        PedidoShowroom pedido = pedidoRepository.findByIdWithItems(id)
                .orElseThrow(() -> new NotFoundException("Pedido no encontrado: " + id));
        return whatsappBusinessService.motivoNoConfigurado()
                .<ResponseEntity<Map<String, Object>>>map(motivo -> ResponseEntity
                        .status(HttpStatus.SERVICE_UNAVAILABLE)
                        .body(Map.of("error", motivo)))
                .orElseGet(() -> {
                    whatsappBusinessService.enviarPdfAsync(pedido);
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
    public ResponseEntity<Map<String, Object>> regenerarPickitExterno(
            @PathVariable Long id,
            @RequestHeader(value = "X-Client-Id", required = false) String clientId) {
        // findByIdWithItems hidrata los items en la misma query — los necesita
        // el thread @Async para escribir el .xlsx de input al programa pickit.
        PedidoShowroom pedido = pedidoRepository.findByIdWithItems(id)
                .orElseThrow(() -> new NotFoundException("Pedido no encontrado: " + id));
        return pickitExternoService.motivoNoConfigurado()
                .<ResponseEntity<Map<String, Object>>>map(motivo -> ResponseEntity
                        .status(HttpStatus.SERVICE_UNAVAILABLE)
                        .body(Map.of("error", motivo)))
                .orElseGet(() -> {
                    pickitExternoService.generarAsync(pedido, clientId);
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
     *
     * <p>El header {@code X-Client-Id} identifica la pestaña/PC del operador
     * que disparó la creación. Se propaga al evento SSE del pickit externo
     * para que solo esa PC auto-descargue el .xlsx generado (las otras
     * pantallas igual ven el toast informativo).
     */
    @PostMapping("/pedido-dux")
    public ResponseEntity<CrearPedidoResponseDTO> crearPedido(
            @RequestBody @Valid CrearPedidoRequestDTO request,
            @RequestHeader(value = "X-Client-Id", required = false) String clientId) {
        CrearPedidoResponseDTO response = service.crearPedido(request, clientId);
        HttpStatus status = response.estado() == EstadoPedido.ENVIADO
                ? HttpStatus.CREATED
                : HttpStatus.ACCEPTED; // 202 si quedó local pero DUX falló
        return ResponseEntity.status(status).body(response);
    }

    // =====================================================
    // Presupuesto comercial (pantalla /presupuestos) — PDF al cliente,
    // NO toca DUX. Persiste local con número auto-incremental.
    // =====================================================

    /**
     * Genera el PDF de presupuesto comercial, lo persiste con número
     * definitivo y lo devuelve para descargar. Usado por el botón
     * "Descargar PDF" del frontend — el operador puede mandárselo manual
     * al cliente. Cada llamada consume un número de presupuesto.
     */
    @PostMapping(value = "/presupuesto-comercial/preview",
            produces = MediaType.APPLICATION_PDF_VALUE)
    public ResponseEntity<byte[]> previewPresupuesto(
            @RequestBody @Valid GenerarPresupuestoRequestDTO body) {
        PresupuestoComercialService.Resultado r = presupuestoComercialService.generarYPersistir(body);
        // Usamos `attachment` (no `inline`) para que Chrome no bloquee la
        // descarga como "no segura": cuando combinamos blob URL + a.click()
        // + window.open() automático, browsers modernos consideran sospechosa
        // la combinación si el header dice `inline`. `attachment` es explícito
        // sobre la intención de descarga y desactiva el bloqueo.
        return ResponseEntity.ok()
                .contentType(MediaType.APPLICATION_PDF)
                .header(HttpHeaders.CONTENT_DISPOSITION,
                        "attachment; filename=\"" + r.nombreArchivo() + "\"")
                .header(HttpHeaders.ACCESS_CONTROL_EXPOSE_HEADERS, HttpHeaders.CONTENT_DISPOSITION)
                .header("X-Presupuesto-Id", String.valueOf(r.presupuesto().getId()))
                .body(r.pdf());
    }

    /**
     * Listado paginado de presupuestos comerciales guardados — para la
     * pantalla {@code /presupuestos/historial}. Filtros opcionales por
     * texto libre (nombre/email/teléfono), rango de fechas e id puntual
     * (deep-link). Default: más recientes primero, 50 por página.
     */
    @GetMapping("/presupuesto-comercial")
    public ar.com.leo.showroom.presupuesto.dto.PresupuestoListPageDTO listarPresupuestos(
            @RequestParam(value = "id", required = false) Long id,
            @RequestParam(value = "q", required = false) String q,
            @RequestParam(value = "desde", required = false) Instant desde,
            @RequestParam(value = "hasta", required = false) Instant hasta,
            @RequestParam(value = "page", defaultValue = "0") int page,
            @RequestParam(value = "size", defaultValue = "50") int size) {
        return presupuestoComercialService.listar(id, q, desde, hasta, page, size);
    }

    /** Vista agrupada por cliente — un row por persona con email/teléfono/
     *  nombre, cantidad de presupuestos y fecha del último. La usa la pantalla
     *  {@code /presupuestos/clientes}. No paginamos: la cantidad de clientes
     *  es manejable en memoria. */
    @GetMapping("/presupuesto-comercial/clientes")
    public java.util.List<ar.com.leo.showroom.presupuesto.dto.ClientePresupuestosDTO> listarClientesPresupuestos() {
        return presupuestoComercialService.listarClientes();
    }

    /**
     * Descarga el PDF de un presupuesto persistido. Regenera el PDF a
     * partir de los datos guardados (no se almacena el binario), así
     * cualquier mejora del layout se aplica retroactivamente. El número
     * y los datos del cliente quedan congelados al momento de la creación.
     *
     * <p>Query param opcional {@code modo}:
     * <ul>
     *   <li>{@code agregado}: fuerza el formato tradicional (tabla + total
     *       + formas globales).</li>
     *   <li>{@code individual}: fuerza el formato de una hoja por producto.</li>
     *   <li>(omitido): respeta el modo con el que se generó originalmente.</li>
     * </ul>
     * Las formas de pago se recalculan en el service cuando hace falta
     * cambiar de modo (porque el JSON persistido tiene un solo shape).
     */
    @GetMapping(value = "/presupuesto-comercial/{id}/pdf",
            produces = MediaType.APPLICATION_PDF_VALUE)
    public ResponseEntity<byte[]> descargarPdfPresupuesto(
            @PathVariable Long id,
            @RequestParam(value = "modo", required = false) String modo) {
        PresupuestoComercialService.Resultado r =
                presupuestoComercialService.regenerarPdf(id, modo);
        // `attachment` en lugar de `inline` evita que Chrome bloquee la
        // descarga como "no segura" — la combinación blob + a.click() +
        // window.open() automático con header `inline` dispara el bloqueo
        // de mixed/automated downloads en browsers modernos.
        return ResponseEntity.ok()
                .contentType(MediaType.APPLICATION_PDF)
                .header(HttpHeaders.CONTENT_DISPOSITION,
                        "attachment; filename=\"" + r.nombreArchivo() + "\"")
                .header(HttpHeaders.ACCESS_CONTROL_EXPOSE_HEADERS, HttpHeaders.CONTENT_DISPOSITION)
                .body(r.pdf());
    }

    /**
     * Soft-delete de un presupuesto. Setea {@code eliminado_at = now()} en
     * la entity y el listado del historial deja de mostrarlo. El registro
     * físicamente persiste — para recuperar manualmente:
     * {@code UPDATE presupuesto_comercial SET eliminado_at = NULL WHERE id = ?}.
     */
    @DeleteMapping("/presupuesto-comercial/{id}")
    public ResponseEntity<Void> eliminarPresupuesto(@PathVariable Long id) {
        presupuestoComercialService.eliminar(id);
        return ResponseEntity.noContent().build();
    }

    /**
     * Genera + persiste + dispara el envío del email al cliente. Async — el
     * resultado real (SENT/FAILED) llega vía SSE {@code presupuesto-comercial-email}.
     * Devuelve 202 con el número de presupuesto asignado.
     */
    @PostMapping("/presupuesto-comercial/enviar")
    public ResponseEntity<Map<String, Object>> enviarPresupuesto(
            @RequestBody @Valid EnviarPresupuestoRequestDTO body) {
        java.util.Optional<String> motivo = presupuestoComercialService.motivoEmailNoConfigurado();
        if (motivo.isPresent()) {
            return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
                    .body(Map.of("error", motivo.get()));
        }
        PresupuestoComercialService.Resultado r =
                presupuestoComercialService.generarYEnviarPorEmail(body.email(), body.presupuesto());
        return ResponseEntity.accepted().body(Map.of(
                "message", "Envío encolado — el toast confirmará cuando salga.",
                "presupuestoId", r.presupuesto().getId(),
                "email", body.email()));
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
     * sin exponer el token en curl. Ej: `GET /api/showroom/admin/dux-get?path=/percepcionesImpuestos`.
     */
    @GetMapping(value = "/admin/dux-get", produces = MediaType.APPLICATION_JSON_VALUE)
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
     * Listado completo de formas de pago (activas + inactivas) para la pantalla
     * de configuración. El operador ve todas y puede activar/desactivar.
     */
    @GetMapping("/config/formas-pago")
    public List<FormaPagoDTO> listarFormasPagoConfig() {
        return formaPagoService.listarTodas().stream().map(FormaPagoService::toDTO).toList();
    }

    /**
     * Listado solo de las formas activas — para el selector del operador en
     * el carrito al armar un pedido. Endpoint separado del de configuración
     * para evitar mezclar conceptos.
     */
    @GetMapping("/formas-pago/activas")
    public List<FormaPagoDTO> listarFormasPagoActivas() {
        return formaPagoService.listarActivas().stream().map(FormaPagoService::toDTO).toList();
    }

    @PostMapping("/config/formas-pago")
    public FormaPagoDTO crearFormaPago(@RequestBody @Valid FormaPagoDTO dto) {
        return FormaPagoService.toDTO(formaPagoService.crear(dto));
    }

    @PutMapping("/config/formas-pago/{id}")
    public FormaPagoDTO actualizarFormaPago(
            @PathVariable Long id,
            @RequestBody @Valid FormaPagoDTO dto) {
        return FormaPagoService.toDTO(formaPagoService.actualizar(id, dto));
    }

    /** Soft delete — la forma de pago queda con activo=false y deja de aparecer
     *  en el selector del operador. Pedidos viejos preservan su snapshot. */
    @DeleteMapping("/config/formas-pago/{id}")
    public ResponseEntity<Void> eliminarFormaPago(@PathVariable Long id) {
        formaPagoService.eliminar(id);
        return ResponseEntity.noContent().build();
    }

    // =====================================================
    // Perfiles de etiquetas — compartidos entre PCs
    // =====================================================
    // El "perfil activo" lo elige cada PC localmente (localStorage); la lista
    // de perfiles se comparte para que un setup nuevo aparezca al instante en
    // todas las PCs del showroom.

    @GetMapping("/config/perfiles-etiquetas")
    public List<PerfilEtiquetasDTO> listarPerfilesEtiquetas() {
        return perfilEtiquetasService.listar();
    }

    @PostMapping("/config/perfiles-etiquetas")
    public PerfilEtiquetasDTO crearPerfilEtiquetas(@RequestBody @Valid PerfilEtiquetasDTO dto) {
        return perfilEtiquetasService.crear(dto);
    }

    @PutMapping("/config/perfiles-etiquetas/{id}")
    public PerfilEtiquetasDTO actualizarPerfilEtiquetas(
            @PathVariable Long id,
            @RequestBody @Valid PerfilEtiquetasDTO dto) {
        return perfilEtiquetasService.actualizar(id, dto);
    }

    @DeleteMapping("/config/perfiles-etiquetas/{id}")
    public ResponseEntity<Void> eliminarPerfilEtiquetas(@PathVariable Long id) {
        perfilEtiquetasService.eliminar(id);
        return ResponseEntity.noContent().build();
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

    /**
     * Toggles para habilitar/deshabilitar el envío automático del PDF tras
     * pedido OK (email y/o whatsapp). Ojo: NO afectan los botones manuales en
     * /pedidos ni /historial — esos siguen disponibles siempre que la integración
     * a nivel sistema (env vars SMTP / Meta token) esté ok.
     */
    @GetMapping("/config/notificaciones-auto")
    public NotificacionesAutoConfigDTO obtenerNotificacionesAuto() {
        return service.getNotificacionesAuto();
    }

    @PutMapping("/config/notificaciones-auto")
    public NotificacionesAutoConfigDTO actualizarNotificacionesAuto(@RequestBody NotificacionesAutoConfigDTO body) {
        return service.saveNotificacionesAuto(body);
    }

    /**
     * Cuerpo del mensaje (caption) que acompaña al PDF en WhatsApp. El operador
     * lo edita desde /configuracion. Si la fila no existe en DB se devuelve el
     * default de {@code showroom.whatsapp.mensaje-cuerpo} con
     * {@code personalizado=false} para que la UI pueda señalarlo.
     */
    @GetMapping("/config/whatsapp-mensaje")
    public WhatsappMensajeConfigDTO obtenerWhatsappMensaje() {
        return service.getWhatsappMensaje();
    }

    @PutMapping("/config/whatsapp-mensaje")
    public WhatsappMensajeConfigDTO actualizarWhatsappMensaje(@RequestBody WhatsappMensajeConfigDTO body) {
        return service.saveWhatsappMensaje(body);
    }

    /**
     * Toggle global de sincronización automática con DUX. Cuando es false los
     * disparos de los horarios programados se saltean (los horarios no se borran,
     * solo se pausa). Útil para pausar la sync cuando DUX está caído.
     */
    @GetMapping("/config/sync-auto")
    public Map<String, Boolean> obtenerSyncAuto() {
        return Map.of("habilitada", service.isSyncAutoHabilitada());
    }

    @PutMapping("/config/sync-auto")
    public Map<String, Boolean> actualizarSyncAuto(@RequestBody Map<String, Boolean> body) {
        boolean habilitada = Boolean.TRUE.equals(body.get("habilitada"));
        return Map.of("habilitada", service.setSyncAutoHabilitada(habilitada));
    }

    /** Timestamp (epoch ms) cuando el bean se inicializó — equivale al boot del
     *  backend porque el controller se crea una sola vez. Lo expone {@code /health}
     *  para que el frontend detecte reinicios del backend: si llega un boot nuevo,
     *  el estado in-memory del server (carrito + sesión) se perdió y conviene
     *  limpiar los signals locales del cliente para no mostrar fantasmas. */
    private final long bootTimeMs = System.currentTimeMillis();

    @GetMapping("/health")
    public Map<String, Object> health() {
        Map<String, Object> body = new HashMap<>();
        body.put("bootTimeMs", bootTimeMs);
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
