package ar.com.leo.showroom.showroom.service;

import ar.com.leo.showroom.catalogo.entity.ProductoCache;
import ar.com.leo.showroom.catalogo.repository.LocalidadRepository;
import ar.com.leo.showroom.catalogo.repository.ProductoCacheRepository;
import ar.com.leo.showroom.catalogo.repository.ProductoCacheSpecs;
import ar.com.leo.showroom.catalogo.repository.ProvinciaRepository;
import ar.com.leo.showroom.catalogo.service.CatalogoSyncService;
import ar.com.leo.showroom.catalogo.service.ImagenLocalService;
import ar.com.leo.showroom.common.exception.ConflictException;
import ar.com.leo.showroom.common.exception.NotFoundException;
import ar.com.leo.showroom.common.exception.UserMessages;
import ar.com.leo.showroom.config.service.ConfiguracionService;
import ar.com.leo.showroom.config.entity.FormaPago;
import ar.com.leo.showroom.config.service.EscalaDescuentoService;
import ar.com.leo.showroom.config.service.FormaPagoService;
import ar.com.leo.showroom.config.service.HorarioSyncSchedulerService;
import ar.com.leo.showroom.dux.config.DuxProperties;
import ar.com.leo.showroom.dux.service.DuxClient;
import ar.com.leo.showroom.events.SyncEventService;
import ar.com.leo.showroom.pedido.entity.EstadoPedido;
import ar.com.leo.showroom.pedido.entity.PedidoShowroom;
import ar.com.leo.showroom.pedido.entity.PedidoShowroomItem;
import ar.com.leo.showroom.pedido.repository.PedidoShowroomRepository;
import ar.com.leo.showroom.sesion.repository.SesionShowroomRepository;
import ar.com.leo.showroom.picking.PdfFollowupOrchestrator;
import ar.com.leo.showroom.pickit_externo.PickitExternoService;
import ar.com.leo.showroom.sesion.service.SesionShowroomService;
import ar.com.leo.showroom.showroom.dto.CatalogoItemDTO;
import ar.com.leo.showroom.showroom.dto.CatalogoPageDTO;
import ar.com.leo.showroom.showroom.dto.CrearPedidoRequestDTO;
import ar.com.leo.showroom.showroom.dto.CrearPedidoResponseDTO;
import ar.com.leo.showroom.showroom.dto.EscalaDescuentoDTO;
import ar.com.leo.showroom.showroom.dto.ConversionProductoDTO;
import ar.com.leo.showroom.showroom.dto.EstadisticaProductoDTO;
import ar.com.leo.showroom.showroom.dto.EstadisticasHistorialDTO;
import ar.com.leo.showroom.showroom.dto.TasaConversionGlobalDTO;
import ar.com.leo.showroom.showroom.dto.HorarioSyncDTO;
import ar.com.leo.showroom.showroom.dto.PedidoDetailDTO;
import ar.com.leo.showroom.showroom.dto.PedidoItemDTO;
import ar.com.leo.showroom.showroom.dto.PedidoListItemDTO;
import ar.com.leo.showroom.showroom.dto.PedidoListPageDTO;
import ar.com.leo.showroom.showroom.dto.NotificacionesAutoConfigDTO;
import ar.com.leo.showroom.showroom.dto.PickitConfigDTO;
import ar.com.leo.showroom.showroom.dto.WhatsappMensajeConfigDTO;
import ar.com.leo.showroom.showroom.dto.ProductoListItemDTO;
import ar.com.leo.showroom.showroom.dto.ProductoListPageDTO;
import ar.com.leo.showroom.showroom.dto.ScanResultDTO;
import jakarta.transaction.Transactional;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Pageable;
import org.springframework.data.domain.Sort;
import org.springframework.data.jpa.domain.Specification;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.util.StringUtils;
import tools.jackson.databind.ObjectMapper;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Instant;
import java.time.ZoneId;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.util.*;
import java.util.stream.Collectors;

@Slf4j
@Service
@RequiredArgsConstructor
public class ShowroomService {

    private static final BigDecimal CIEN = new BigDecimal("100");
    private static final DateTimeFormatter DUX_FECHA = DateTimeFormatter.ofPattern("ddMMyyyy");
    /** DUX espera la fecha en horario Argentina, no en UTC del servidor. */
    private static final ZoneId ZONA_AR = ZoneId.of("America/Argentina/Buenos_Aires");

    private final CatalogoSyncService catalogoSync;
    private final DuxClient duxClient;
    private final PedidoShowroomRepository pedidoRepository;
    private final SesionShowroomRepository sesionRepository;
    private final ProductoCacheRepository productoCacheRepository;
    private final ObjectMapper objectMapper;
    private final DuxProperties duxProperties;
    private final PdfFollowupOrchestrator pdfFollowupOrchestrator;
    private final PickitExternoService pickitExternoService;
    private final SesionShowroomService sesionShowroomService;
    private final ar.com.leo.showroom.auth.repository.UsuarioRepository usuarioRepository;
    private final SyncEventService eventService;
    private final ImagenLocalService imagenLocalService;
    private final ProvinciaRepository provinciaRepository;
    private final LocalidadRepository localidadRepository;
    private final EscalaDescuentoService escalaDescuentoService;
    private final FormaPagoService formaPagoService;
    private final HorarioSyncSchedulerService horarioSyncService;
    private final ConfiguracionService configuracionService;

    /**
     * Lookup en cache local por SKU o código de barras:
     *  1. Busca el SKU en cache.
     *  2. Si no, busca por código de barras (EAN-13) en cache.
     *  3. Si tampoco, asume que era un SKU y lo pide a DUX on-demand.
     *     (DUX no expone búsqueda por EAN, así que el on-demand solo
     *     resuelve si el código que mandaron era un SKU.)
     */
    public ScanResultDTO scan(String codigo) {
        if (codigo == null || codigo.isBlank()) {
            throw new NotFoundException("Código vacío");
        }
        String limpio = codigo.trim();

        Optional<ProductoCache> opt = catalogoSync.buscarPorSkuOEan(limpio);
        ProductoCache pc = opt.orElseGet(() -> {
            log.info("Código {} no estaba en cache; pidiendo on-demand a DUX (asumiendo SKU)", limpio);
            List<ProductoCache> nuevos = catalogoSync.refrescarSkus(List.of(limpio));
            if (nuevos.isEmpty()) {
                throw new NotFoundException("Producto no encontrado: " + limpio);
            }
            return nuevos.getFirst();
        });

        return toScanResult(pc);
    }

    /**
     * Refresh on-demand de stock + precios (1 request DUX por SKU, ~7s c/u).
     */
    public List<ScanResultDTO> refrescarStock(List<String> skus) {
        return catalogoSync.refrescarSkus(skus).stream().map(this::toScanResult).toList();
    }

    /**
     * Escalones de descuento configurados (orden ascendente por umbral).
     * El frontend los lee al iniciar para decidir qué % aplicar al carrito.
     */
    public List<EscalaDescuentoDTO> listarEscalasDescuento() {
        return escalaDescuentoService.listar().stream()
                .map(e -> new EscalaDescuentoDTO(e.getUmbralMin(), e.getPorcentaje()))
                .toList();
    }

    /**
     * Reemplaza la lista de escalones por la recibida (operación atómica).
     * Devuelve la lista resultante ya ordenada por umbral asc.
     */
    public List<EscalaDescuentoDTO> reemplazarEscalasDescuento(List<EscalaDescuentoDTO> nuevas) {
        return escalaDescuentoService.reemplazar(nuevas).stream()
                .map(e -> new EscalaDescuentoDTO(e.getUmbralMin(), e.getPorcentaje()))
                .toList();
    }

    /**
     * Horarios diarios de sincronización automática con DUX (zona AR).
     * El frontend los muestra en la pantalla de configuración.
     */
    public List<HorarioSyncDTO> listarHorariosSync() {
        return horarioSyncService.listar().stream()
                .map(h -> new HorarioSyncDTO(h.getHora(), h.getMinuto()))
                .toList();
    }

    /**
     * Reemplaza la lista de horarios. El servicio reprograma los disparos
     * inmediatamente — los cambios aplican sin reiniciar el backend.
     */
    public List<HorarioSyncDTO> reemplazarHorariosSync(List<HorarioSyncDTO> nuevos) {
        return horarioSyncService.reemplazar(nuevos).stream()
                .map(h -> new HorarioSyncDTO(h.getHora(), h.getMinuto()))
                .toList();
    }

    /** Configuración runtime del pickit externo (paths del jar + Excels auxiliares + output dir). */
    public PickitConfigDTO getPickitConfig() {
        return configuracionService.getPickitConfig();
    }

    /** Persiste la config del pickit externo. Valida que los paths estén presentes si enabled=true. */
    public PickitConfigDTO savePickitConfig(PickitConfigDTO cfg) {
        return configuracionService.savePickitConfig(cfg);
    }

    /** Toggles de envío automático del PDF tras pedido (email + whatsapp). */
    public NotificacionesAutoConfigDTO getNotificacionesAuto() {
        return configuracionService.getNotificacionesAuto();
    }

    public NotificacionesAutoConfigDTO saveNotificacionesAuto(NotificacionesAutoConfigDTO cfg) {
        return configuracionService.saveNotificacionesAuto(cfg);
    }

    /** Toggle global de sync automática con DUX. Permite pausar las tareas
     *  programadas (horarios) sin tener que borrarlas — útil cuando DUX está
     *  caído o se va a hacer mantenimiento. */
    public boolean isSyncAutoHabilitada() {
        return configuracionService.isSyncAutoHabilitada();
    }

    public boolean setSyncAutoHabilitada(boolean habilitada) {
        return configuracionService.setSyncAutoHabilitada(habilitada);
    }

    /** Cuerpo del mensaje (caption) que acompaña al PDF en WhatsApp. Editable
     *  desde /configuracion; si no hay valor en DB se devuelve el default del
     *  application.properties. */
    public WhatsappMensajeConfigDTO getWhatsappMensaje() {
        return configuracionService.getWhatsappMensaje();
    }

    public WhatsappMensajeConfigDTO saveWhatsappMensaje(WhatsappMensajeConfigDTO cfg) {
        return configuracionService.saveWhatsappMensaje(cfg);
    }

    /** URL base para el QR del visor (ej. http://192.168.1.50:4200). Vacío →
     *  el frontend cae a window.location.origin. */
    public String getVisorBaseUrl() {
        return configuracionService.getVisorBaseUrl();
    }

    public String saveVisorBaseUrl(String baseUrl) {
        return configuracionService.saveVisorBaseUrl(baseUrl);
    }


    /**
     * Búsqueda paginada en el cache local (sin tocar DUX).
     * Usada por la pantalla de generación de etiquetas QR.
     */
    public CatalogoPageDTO buscarCatalogo(String q, int page, int size) {
        int pageSafe = Math.max(0, page);
        int sizeSafe = Math.min(Math.max(size, 1), 200);
        List<String> tokens = ProductoCacheSpecs.tokenizar(q);
        // Si no hay tokens, devolvemos paginado por SKU asc (sin ranking).
        Pageable pageable = tokens.isEmpty()
                ? PageRequest.of(pageSafe, sizeSafe, Sort.by(Sort.Direction.ASC, "sku"))
                : PageRequest.of(pageSafe, sizeSafe);
        Specification<ProductoCache> spec = ProductoCacheSpecs.matchTokens(tokens, true);
        Page<ProductoCache> resultado = productoCacheRepository.findAll(spec, pageable);
        List<CatalogoItemDTO> items = resultado.getContent().stream()
                .map(this::toCatalogoItem)
                .toList();
        return new CatalogoPageDTO(items, resultado.getTotalElements(), pageSafe, sizeSafe);
    }

    /**
     * Lookup bulk en el cache local (sin tocar DUX). Devuelve solo los SKUs encontrados.
     */
    public List<CatalogoItemDTO> lookup(List<String> skus) {
        if (skus == null || skus.isEmpty()) return List.of();
        List<String> limpios = skus.stream()
                .filter(Objects::nonNull)
                .map(String::trim)
                .filter(s -> !s.isBlank())
                .toList();
        if (limpios.isEmpty()) return List.of();
        return productoCacheRepository.findBySkuIn(limpios).stream()
                .map(this::toCatalogoItem)
                .toList();
    }

    private CatalogoItemDTO toCatalogoItem(ProductoCache pc) {
        BigDecimal sinIva = calcularSinIva(pc.getPvpKtGastroConIva(), pc.getPorcIva());
        return new CatalogoItemDTO(
                pc.getSku(),
                pc.getDescripcion(),
                sinIva,
                pc.getHabilitado(),
                urlImagenLocal(pc.getSku()),
                pc.getStockTotal());
    }

    /**
     * Búsqueda paginada con filtros para la pantalla de listado de productos.
     * Versión enriquecida de buscarCatalogo: incluye stock, precio c/IVA y
     * timestamp de última sync.
     */
    /** Whitelist de campos ordenables del listado de productos. */
    private static final Map<String, String> SORT_PRODUCTOS = Map.of(
            "sku", "sku",
            "descripcion", "descripcion",
            "pvpKtGastroConIva", "pvpKtGastroConIva",
            "pvpKtGastroSinIva", "pvpKtGastroConIva", // mismo campo (sin-IVA es derivado)
            "porcIva", "porcIva",
            "stockTotal", "stockTotal",
            "habilitado", "habilitado",
            "sincronizadoAt", "sincronizadoAt"
    );

    public ProductoListPageDTO buscarProductos(
            String q,
            boolean soloDeshabilitados,
            boolean soloSinStock,
            int page,
            int size,
            String sortField,
            String sortOrder) {
        int pageSafe = Math.max(0, page);
        int sizeSafe = Math.min(Math.max(size, 1), 200);
        List<String> tokens = ProductoCacheSpecs.tokenizar(q);

        // El operador eligió un sort de columna (clickeable) → respetar.
        // Sin sort explícito + hay tokens → ranking por relevancia desde la spec.
        // Sin sort explícito + sin tokens → SKU asc por default.
        boolean operadorEligioSort = sortField != null && SORT_PRODUCTOS.containsKey(sortField);
        Pageable pageable;
        boolean aplicarRanking;
        if (operadorEligioSort) {
            String campo = SORT_PRODUCTOS.get(sortField);
            Sort.Direction dir = "desc".equalsIgnoreCase(sortOrder) ? Sort.Direction.DESC : Sort.Direction.ASC;
            pageable = PageRequest.of(pageSafe, sizeSafe, Sort.by(dir, campo));
            aplicarRanking = false;
        } else if (!tokens.isEmpty()) {
            pageable = PageRequest.of(pageSafe, sizeSafe);
            aplicarRanking = true;
        } else {
            pageable = PageRequest.of(pageSafe, sizeSafe, Sort.by(Sort.Direction.ASC, "sku"));
            aplicarRanking = false;
        }

        Specification<ProductoCache> spec = ProductoCacheSpecs.matchTokens(tokens, aplicarRanking);
        if (soloDeshabilitados) spec = spec.and(ProductoCacheSpecs.soloDeshabilitados());
        if (soloSinStock) spec = spec.and(ProductoCacheSpecs.soloSinStock());

        Page<ProductoCache> resultado = productoCacheRepository.findAll(spec, pageable);
        // Bulk fetch de codigosBarra (colección lazy @ElementCollection) en una
        // sola query — tocarla via pc.getCodigosBarra() explotaría con
        // LazyInitializationException al estar OSIV desactivado.
        List<Long> ids = resultado.getContent().stream().map(ProductoCache::getId).toList();
        Map<Long, List<String>> codigosPorProducto = ids.isEmpty()
                ? Map.of()
                : productoCacheRepository.findCodigosBarraByProductoIds(ids).stream()
                        .collect(Collectors.groupingBy(
                                row -> (Long) row[0],
                                Collectors.mapping(row -> (String) row[1], Collectors.toList())));
        List<ProductoListItemDTO> items = resultado.getContent().stream()
                .map(pc -> toProductoListItem(pc, codigosPorProducto.getOrDefault(pc.getId(), List.of())))
                .toList();
        return new ProductoListPageDTO(items, resultado.getTotalElements(), pageSafe, sizeSafe);
    }

    /**
     * Whitelist de campos por los que se permite ordenar el listado de pedidos.
     * Mapea el nombre que manda el frontend (id de columna del p-table) al
     * nombre del atributo en la entity. Evita ataques tipo "SQL injection
     * via sort field" al pasar el parámetro directo al ORDER BY.
     */
    private static final Map<String, String> SORT_PEDIDOS = Map.of(
            "creadoAt", "creadoAt",
            "estado", "estado",
            "nroDoc", "nroDoc",
            // El header "Cliente" del listado ordena por `nombre` (el dato real
            // del cliente). Antes era `apellidoRazonSocial`, pero ahora ese campo
            // es el placeholder fijo "PEDIDO SHOWROOM" → ordenar por él no aportaba.
            "nombre", "nombre",
            "descuentoPorcentaje", "descuentoPorcentaje",
            "totalSinIva", "totalSinIva",
            "total", "total"
    );

    /**
     * Listado paginado de pedidos persistidos en la BD local. Permite buscar por
     * substring en el nro_doc (CUIT) o nombre, filtrar por estado y rango de
     * fechas, y ordenar por cualquier columna whitelisted.
     */
    public PedidoListPageDTO listarPedidos(
            Long id,
            String q,
            EstadoPedido estado,
            Instant desde,
            Instant hasta,
            int page,
            int size,
            String sortField,
            String sortOrder) {
        int pageSafe = Math.max(0, page);
        int sizeSafe = Math.min(Math.max(size, 1), 200);
        // Resolver el sort: si el campo no está en la whitelist o no se pidió,
        // usar `creadoAt desc` (default histórico de la pantalla).
        String campo = SORT_PEDIDOS.getOrDefault(sortField, "creadoAt");
        Sort.Direction direccion = "asc".equalsIgnoreCase(sortOrder)
                ? Sort.Direction.ASC
                : Sort.Direction.DESC;
        Sort sort = Sort.by(direccion, campo);
        Page<PedidoShowroom> resultado = pedidoRepository.buscar(
                id,
                q == null ? null : q.trim(),
                estado,
                desde,
                hasta,
                PageRequest.of(pageSafe, sizeSafe, sort)
        );
        // Bulk count de items por pedido en una sola query — accederla via
        // p.getItems().size() explotaría con LazyInitializationException al
        // estar OSIV desactivado (la sesión Hibernate cierra al salir del repo).
        List<Long> ids = resultado.getContent().stream().map(PedidoShowroom::getId).toList();
        Map<Long, Integer> cantidadItems = ids.isEmpty()
                ? Map.of()
                : pedidoRepository.contarItemsPorPedidoIds(ids).stream()
                        .collect(Collectors.toMap(
                                row -> (Long) row[0],
                                row -> ((Number) row[1]).intValue()));
        // Bulk lookup de operadores: una sola query para todos los usuarioId
        // distintos de la página. Evita N+1 contra usuario_repository al
        // mapear cada pedido a su DTO.
        Map<Long, String> operadores = resolverOperadoresDePedidos(resultado.getContent());
        List<PedidoListItemDTO> items = resultado.getContent().stream()
                .map(p -> toPedidoListItem(p, cantidadItems.getOrDefault(p.getId(), 0), operadores))
                .toList();
        return new PedidoListPageDTO(items, resultado.getTotalElements(), pageSafe, sizeSafe);
    }

    /** Devuelve un mapa {@code usuarioId → displayName} para los operadores
     *  presentes en la página. {@code displayName} prefiere {@code nombre}
     *  (más legible) y cae a {@code username} si está vacío. Una sola query. */
    private Map<Long, String> resolverOperadoresDePedidos(List<PedidoShowroom> pedidos) {
        Set<Long> ids = pedidos.stream()
                .map(PedidoShowroom::getUsuarioId)
                .filter(Objects::nonNull)
                .collect(Collectors.toSet());
        if (ids.isEmpty()) return Map.of();
        return usuarioRepository.findAllById(ids).stream()
                .collect(Collectors.toMap(
                        u -> u.getId(),
                        u -> displayNameOperador(u.getNombre(), u.getUsername())));
    }

    /** Display name del operador: prefiere {@code nombre}, fallback a username.
     *  Reutilizado por sesiones/presupuestos para mantener consistencia visual. */
    private static String displayNameOperador(String nombre, String username) {
        if (nombre != null && !nombre.isBlank()) return nombre.trim();
        return username;
    }

    /**
     * Estadísticas para los charts del historial:
     *  - Top N productos más escaneados (despertaron interés).
     *  - Top N productos más comprados (concretaron en venta).
     *
     * <p>Excluye pedidos anulados del top-comprados — solo cuentan los que
     * realmente se concretaron. El rango de fechas es opcional; sin él agrega
     * sobre toda la historia.
     *
     * @param topN cuántos productos devolver por ranking (default 10, max 50).
     */
    public EstadisticasHistorialDTO obtenerEstadisticasHistorial(
            Instant desde, Instant hasta, int topN) {
        int limitSafe = Math.min(Math.max(topN, 1), 50);
        Pageable limit = PageRequest.of(0, limitSafe);

        // KPI global: cuántas sesiones cerradas terminaron en pedido (no anulado).
        long finalizadas = sesionRepository.contarFinalizadas(desde, hasta);
        long conPedido = sesionRepository.contarConPedido(desde, hasta);

        // Tasa de conversión por producto: numerador = sesiones únicas que
        // escanearon X y compraron X; denominador = sesiones únicas que
        // escanearon X. Da un % real (0..100) que responde "de los clientes
        // que vieron este producto, ¿qué % lo terminó comprando?".
        //
        // Filtramos productos con muy pocos scans (<2) para evitar ruido — un
        // SKU escaneado 1 vez y comprado 1 vez daría 100% pero no es
        // estadísticamente relevante. Ordenamos por % desc; desempate por
        // sesiones con compra (el producto que convirtió a más clientes primero).
        Map<String, Long> sesionesConCompraPorSku = sesionRepository
                .contarSesionesConvertidasPorSku(desde, hasta).stream()
                .collect(Collectors.toMap(
                        EstadisticaProductoDTO::sku,
                        EstadisticaProductoDTO::total,
                        (a, b) -> a));
        final int MIN_SCANS = 2;
        List<ConversionProductoDTO> topConversion = sesionRepository
                .contarSesionesEscaneadasPorSku(desde, hasta).stream()
                .filter(esc -> esc.total() >= MIN_SCANS)
                .map(esc -> {
                    long convertidas = sesionesConCompraPorSku.getOrDefault(esc.sku(), 0L);
                    double pct = esc.total() > 0
                            ? Math.round((convertidas * 1000.0) / esc.total()) / 10.0
                            : 0.0;
                    return new ConversionProductoDTO(
                            esc.sku(), esc.descripcion(), esc.total(), convertidas, pct);
                })
                .sorted(java.util.Comparator
                        .comparingDouble(ConversionProductoDTO::porcentaje).reversed()
                        .thenComparingLong(ConversionProductoDTO::sesionesConCompra).reversed())
                .limit(limitSafe)
                .toList();

        return new EstadisticasHistorialDTO(
                sesionRepository.topEscaneados(desde, hasta, limit),
                pedidoRepository.topComprados(desde, hasta, limit),
                new TasaConversionGlobalDTO(finalizadas, conPedido),
                topConversion
        );
    }

    public PedidoDetailDTO obtenerPedido(Long id) {
        // findByIdWithItems hace JOIN FETCH de la colección — sin esto, iterar
        // p.getItems() fuera del @Transactional explota con LazyInitializationException
        // (OSIV está desactivado, la sesión Hibernate cierra al salir del repo).
        PedidoShowroom p = pedidoRepository.findByIdWithItems(id)
                .orElseThrow(() -> new NotFoundException("Pedido no encontrado: " + id));
        List<PedidoItemDTO> items = p.getItems().stream()
                .map(it -> new PedidoItemDTO(
                        it.getSku(),
                        it.getDescripcion(),
                        it.getCantidad(),
                        it.getPrecioUnitario(),
                        it.getPorcIva(),
                        urlImagenLocal(it.getSku())))
                .toList();
        String provinciaNombre = p.getCodigoProvincia() != null
                ? provinciaRepository.findByCodIsoIgnoreCase(p.getCodigoProvincia())
                        .map(prov -> "C".equalsIgnoreCase(prov.getCodIso())
                                ? prov.getNombre() + " (CABA)"
                                : prov.getNombre())
                        .orElse(null)
                : null;
        String localidadNombre = resolverLocalidadNombre(p.getIdLocalidad());
        return new PedidoDetailDTO(
                p.getId(),
                p.getCreadoAt(),
                p.getEnviadoAt(),
                p.getAnuladoAt(),
                p.getMotivoAnulacion(),
                p.getEstado(),
                p.getRespuestaDux(),
                p.getNroDoc(),
                p.getTipoDoc(),
                p.getApellidoRazonSocial(),
                p.getNombre(),
                p.getTelefono(),
                p.getEmail(),
                p.getDomicilio(),
                p.getCodigoProvincia(),
                provinciaNombre,
                p.getIdLocalidad(),
                localidadNombre,
                p.getTotal(),
                p.getTotalSinIva(),
                p.getDescuentoPorcentaje(),
                p.getFormaPagoId(),
                p.getFormaPagoNombre(),
                p.getRecargoPorcentaje(),
                p.getCantidadCuotas(),
                p.getFormaPagoAplicaIva(),
                p.getTotalSinRecargo(),
                p.getObservaciones(),
                items
        );
    }

    /**
     * Anula un pedido marcándolo como {@link EstadoPedido#ANULADO}, registrando
     * timestamp y motivo opcional. Idempotente sobre el mismo pedido: si ya está
     * anulado, devuelve {@link ConflictException}.
     *
     * <p><b>Importante:</b> esto NO cancela el comprobante en DUX. La API de DUX
     * no expone una operación de anulación, así que cuando un pedido fue aceptado
     * por DUX (estado previo {@code ENVIADO}) la anulación queda solo del lado
     * local — la operadora tiene que cancelar el comprobante manualmente desde
     * la UI de DUX. El frontend muestra esa advertencia en el diálogo de
     * confirmación.
     *
     * @param motivo texto libre opcional (máx 500 chars). Null/blank → no se persiste.
     */
    @Transactional
    public PedidoDetailDTO anularPedido(Long id, String motivo) {
        PedidoShowroom p = pedidoRepository.findById(id)
                .orElseThrow(() -> new NotFoundException("Pedido no encontrado: " + id));
        if (p.getEstado() == EstadoPedido.ANULADO) {
            throw new ConflictException("El pedido ya está anulado");
        }
        p.setEstado(EstadoPedido.ANULADO);
        p.setAnuladoAt(Instant.now());
        if (motivo != null && !motivo.isBlank()) {
            String trimmed = motivo.trim();
            // length=500 en la columna; truncamos defensivamente para evitar SQLException.
            p.setMotivoAnulacion(trimmed.length() > 500 ? trimmed.substring(0, 500) : trimmed);
        } else {
            p.setMotivoAnulacion(null);
        }
        pedidoRepository.save(p);
        log.info("Pedido id={} anulado. motivo='{}'", id, p.getMotivoAnulacion());
        // Broadcast a TODAS las pantallas para que las listas abiertas en
        // /pedidos se refresquen sin polling. Es global (no per-usuario)
        // porque la lista es global — cualquier operador con la pantalla
        // abierta debe ver el cambio.
        eventService.publish("pedido-actualizado",
                java.util.Map.of("pedidoId", id, "estado", EstadoPedido.ANULADO.name()));
        return obtenerPedido(id);
    }

    /**
     * Revierte la anulación de un pedido. Restaura el estado previo deduciéndolo
     * de los timestamps/respuesta que se conservaron al anular:
     * <ul>
     *   <li>{@code enviadoAt != null} → DUX había aceptado el pedido → {@link EstadoPedido#ENVIADO}.</li>
     *   <li>{@code respuestaDux != null} → DUX había rechazado el pedido → {@link EstadoPedido#ERROR}.</li>
     *   <li>Sino → nunca llegó a DUX → {@link EstadoPedido#PENDIENTE}.</li>
     * </ul>
     * Limpia {@code anuladoAt} y {@code motivoAnulacion}. 409 si el pedido no está ANULADO.
     *
     * <p>NO toca DUX — si el pedido estaba CARGADO_EN_DUX al anular, igual seguía
     * existiendo del lado de DUX (la anulación local nunca lo borró allá). Revertir
     * simplemente sincroniza el sistema con la verdad de DUX.
     */
    @Transactional
    public PedidoDetailDTO reactivarPedido(Long id) {
        PedidoShowroom p = pedidoRepository.findById(id)
                .orElseThrow(() -> new NotFoundException("Pedido no encontrado: " + id));
        if (p.getEstado() != EstadoPedido.ANULADO) {
            throw new ConflictException("El pedido no está anulado — no hay nada que revertir");
        }
        EstadoPedido estadoOriginal;
        if (p.getEnviadoAt() != null) {
            estadoOriginal = EstadoPedido.ENVIADO;
        } else if (p.getRespuestaDux() != null && !p.getRespuestaDux().isBlank()) {
            estadoOriginal = EstadoPedido.ERROR;
        } else {
            estadoOriginal = EstadoPedido.PENDIENTE;
        }
        p.setEstado(estadoOriginal);
        p.setAnuladoAt(null);
        p.setMotivoAnulacion(null);
        pedidoRepository.save(p);
        log.info("Pedido id={} revertido a estado {}", id, estadoOriginal);
        eventService.publish("pedido-actualizado",
                java.util.Map.of("pedidoId", id, "estado", estadoOriginal.name()));
        return obtenerPedido(id);
    }

    /** Resuelve el nombre de localidad a partir del id (String en el pedido).
     *  Devuelve null si el id no es un Long válido o si no se encuentra. */
    private String resolverLocalidadNombre(String idLocalidadStr) {
        if (idLocalidadStr == null || idLocalidadStr.isBlank()) return null;
        try {
            Long idLocalidad = Long.valueOf(idLocalidadStr);
            return localidadRepository.findById(idLocalidad)
                    .map(loc -> loc.getNombre())
                    .orElse(null);
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private PedidoListItemDTO toPedidoListItem(PedidoShowroom p, int cantidadItems,
                                               Map<Long, String> usernamesByUsuarioId) {
        // creadoPor: nombre del operador (o username como fallback) si está
        // en el cache pre-calculado. Null para pedidos legacy sin usuarioId.
        String creadoPor = p.getUsuarioId() == null ? null
                : usernamesByUsuarioId.get(p.getUsuarioId());
        return new PedidoListItemDTO(
                p.getId(),
                p.getCreadoAt(),
                p.getEnviadoAt(),
                p.getAnuladoAt(),
                p.getEstado(),
                p.getNroDoc(),
                p.getApellidoRazonSocial(),
                p.getNombre(),
                p.getEmail(),
                p.getTelefono(),
                p.getTotal(),
                p.getTotalSinIva(),
                p.getDescuentoPorcentaje(),
                p.getFormaPagoNombre(),
                p.getFormaPagoAplicaIva(),
                p.getCantidadCuotas(),
                cantidadItems,
                creadoPor
        );
    }

    private ProductoListItemDTO toProductoListItem(ProductoCache pc, List<String> codigosBarra) {
        List<String> eans = codigosBarra.stream().sorted().toList();
        return new ProductoListItemDTO(
                pc.getSku(),
                pc.getDescripcion(),
                pc.getPvpKtGastroConIva(),
                calcularSinIva(pc.getPvpKtGastroConIva(), pc.getPorcIva()),
                pc.getPorcIva(),
                pc.getStockTotal(),
                pc.getHabilitado(),
                urlImagenLocal(pc.getSku()),
                eans,
                pc.getSincronizadoAt()
        );
    }

    /**
     * Devuelve la URL del endpoint local que sirve la imagen del producto, o
     * null si el archivo no existe en disco. Así el frontend solo hace request
     * cuando hay imagen real para mostrar.
     */
    private String urlImagenLocal(String sku) {
        return imagenLocalService.buscar(sku).isPresent()
                ? "/api/showroom/productos/" + sku + "/imagen"
                : null;
    }

    @Transactional
    public CrearPedidoResponseDTO crearPedido(CrearPedidoRequestDTO request, String clientId, String username) {
        // Si todos los items vienen con el mismo descuento (típico — el frontend manda
        // el descuento global), lo guardamos a nivel pedido también para que la pantalla
        // de listado lo muestre sin tener que iterar items.
        BigDecimal descuentoGlobal = request.items().stream()
                .map(CrearPedidoRequestDTO.Item::descuentoPorcentaje)
                .filter(Objects::nonNull)
                .findFirst()
                .orElse(null);

        // Resolver forma de pago. Si formaPagoId viene, lo buscamos.
        // 400 si la forma_pago no existe — el frontend no debería mandar ids
        // stale; si pasa, es un bug de la UI.
        FormaPago formaPago = null;
        if (request.formaPagoId() != null) {
            formaPago = formaPagoService.obtenerPorId(request.formaPagoId())
                    .orElseThrow(() -> new IllegalArgumentException(
                            "Forma de pago no encontrada: " + request.formaPagoId()));
        }
        BigDecimal recargoPorc = formaPago != null && formaPago.getRecargoPorcentaje() != null
                ? formaPago.getRecargoPorcentaje() : BigDecimal.ZERO;
        boolean aplicaIva = formaPago == null || !Boolean.FALSE.equals(formaPago.getAplicaIva());

        // Snapshot del operador que creó el pedido. Si el username no resuelve
        // a un usuario (caso teórico — el controller siempre manda un username
        // autenticado), queda null y el pedido se trata como legacy.
        Long usuarioId = username == null ? null
                : usuarioRepository.findByUsername(username).map(u -> u.getId()).orElse(null);

        PedidoShowroom pedido = PedidoShowroom.builder()
                .usuarioId(usuarioId)
                .creadoAt(Instant.now())
                .estado(EstadoPedido.PENDIENTE)
                .observaciones(request.observaciones())
                .apellidoRazonSocial(request.apellidoRazonSocial())
                .nombre(StringUtils.hasText(request.nombre()) ? request.nombre() : null)
                .tipoDoc(request.tipoDoc())
                .nroDoc(request.nroDoc())
                .telefono(request.telefono())
                .email(request.email())
                .rubro(request.rubro())
                .domicilio(request.domicilio())
                .codigoProvincia(request.codigoProvincia())
                .idLocalidad(request.idLocalidad())
                .descuentoPorcentaje(descuentoGlobal)
                .formaPagoId(formaPago != null ? formaPago.getId() : null)
                .formaPagoNombre(formaPago != null ? formaPago.getNombre() : null)
                .recargoPorcentaje(formaPago != null ? recargoPorc : null)
                .cantidadCuotas(formaPago != null ? formaPago.getCantidadCuotas() : null)
                .formaPagoAplicaIva(formaPago != null ? aplicaIva : null)
                .build();

        BigDecimal total = BigDecimal.ZERO;
        BigDecimal totalSinIva = BigDecimal.ZERO;
        BigDecimal totalSinRecargo = BigDecimal.ZERO;
        Map<String, ProductoCache> caches = catalogoSync.obtenerPorSkus(
                request.items().stream().map(CrearPedidoRequestDTO.Item::sku).toList()
        );

        for (CrearPedidoRequestDTO.Item it : request.items()) {
            ProductoCache pc = caches.get(it.sku());
            BigDecimal precioBaseConIva = it.precioUnitario() != null
                    ? it.precioUnitario()
                    : (pc != null ? pc.getPvpKtGastroConIva() : null);
            String descripcion = pc != null ? pc.getDescripcion() : null;
            BigDecimal porcIva = pc != null ? pc.getPorcIva() : null;

            // Aplicar recargo (dividir, no multiplicar) y resolver IVA según la
            // forma. Sin formaPago: precio queda igual al base.
            BigDecimal precioFinal = calcularPrecioFinal(precioBaseConIva, porcIva, formaPago);

            PedidoShowroomItem item = PedidoShowroomItem.builder()
                    .pedido(pedido)
                    .sku(it.sku())
                    .descripcion(descripcion)
                    .cantidad(it.cantidad())
                    .precioUnitario(precioFinal)
                    .porcIva(porcIva)
                    .build();
            pedido.getItems().add(item);

            if (precioFinal != null && precioBaseConIva != null) {
                BigDecimal cant = BigDecimal.valueOf(it.cantidad());
                total = total.add(precioFinal.multiply(cant));
                totalSinRecargo = totalSinRecargo.add(precioBaseConIva.multiply(cant));
                // totalSinIva del comprobante DUX: si la forma aplica IVA, el
                // precio_final ya tiene IVA → dividimos. Si no aplica IVA, el
                // precio_final ya es sin IVA → es directo.
                BigDecimal precioSinIvaItem = aplicaIva
                        ? calcularSinIva(precioFinal, porcIva)
                        : precioFinal;
                if (precioSinIvaItem != null) {
                    totalSinIva = totalSinIva.add(precioSinIvaItem.multiply(cant));
                }
            }
        }
        pedido.setTotal(total.setScale(2, RoundingMode.HALF_UP));
        pedido.setTotalSinIva(totalSinIva.setScale(2, RoundingMode.HALF_UP));
        // Solo persistir totalSinRecargo si efectivamente hubo recargo — sino
        // es ruido (el total ya es el sin-recargo).
        if (formaPago != null && recargoPorc.signum() > 0) {
            pedido.setTotalSinRecargo(totalSinRecargo.setScale(2, RoundingMode.HALF_UP));
        }
        pedidoRepository.save(pedido);

        try {
            String body = construirPayloadDux(request, formaPago, caches);
            // No logueamos el payload entero: contiene PII del cliente (CUIT,
            // email, telefono, domicilio, observaciones) y los logs van a archivo
            // persistente (./logs/, rotacion ~500MB). Para diagnostico, el payload
            // serializado vive en `pedido_showroom.respuesta_dux` (consultable por id).
            log.info("DUX POST /pedido/nuevopedido — pedidoId={}, items={}, total={}",
                    pedido.getId(), pedido.getItems().size(), pedido.getTotal());
            String respuesta = duxClient.crearPedido(body);
            log.info("DUX POST /pedido/nuevopedido — pedidoId={} respuesta {} bytes",
                    pedido.getId(), respuesta == null ? 0 : respuesta.length());
            pedido.setRespuestaDux(respuesta);

            // DUX devuelve siempre 200 OK, incluso para errores de validación. El
            // único discriminador es el `message` del body: "Pedido ingresado con exito"
            // → éxito; cualquier otro mensaje → error. La respuesta no incluye el
            // id del comprobante creado, así que no hay forma de linkearlo aquí.
            String mensajeDux = extraerMensajeRespuesta(respuesta);
            boolean exito = mensajeIndicaExito(mensajeDux);

            if (exito) {
                pedido.setEnviadoAt(Instant.now());
                pedido.setEstado(EstadoPedido.ENVIADO);
                pedidoRepository.save(pedido);

                // Force-init de items + apellidoRazonSocial: el async corre fuera de
                // este @Transactional. Si Hibernate hubiera lazy-cargado items, el
                // thread async lanzaría LazyInitializationException al iterarlos.
                // Tocar size() y un getter de un campo simple garantiza la hidratación.
                pedido.getItems().size();
                pedido.getApellidoRazonSocial();

                // Finalizar la sesión de atención asociada (si la hay) y
                // asociarla al pedido recién creado. Esto deja la sesión
                // marcada como "completada" y permite al email service
                // resolverla vía pedidoId al armar el PDF de follow-up.
                sesionShowroomService.finalizarConPedido(username, pedido.getId());

                // Mandar el PDF de follow-up al cliente + generar el pickit
                // externo en PARALELO — dos @Async independientes que corren en
                // threads distintos del pool. El pickit (jar local, ~3-5s) suele
                // terminar bastante antes que SMTP/WhatsApp, así que el operador
                // ve el toast + auto-descarga del .xlsx primero. Si alguno falla
                // solo se loguea — el pedido ya está en DUX, no se revierte.
                //
                // PDF al cliente: WhatsApp primero (si tiene teléfono), email
                // como fallback si WhatsApp no llegó (ventana 24hs cerrada,
                // error, etc.) o no hay teléfono. Lógica en el orquestador.
                //
                // OJO: el orquestador resuelve la sesión por pedidoId
                // (findByPedidoIdWithItems), pero `finalizarConPedido` recién la
                // asoció en ESTA transacción aún sin commitear. Si lo disparamos
                // ya, su @Async corre en otra conexión que todavía ve
                // pedido_id=NULL → cree que "el cliente compró todo lo que vio"
                // y no manda nada. Lo diferimos al afterCommit para que la
                // asociación sesión→pedido ya sea visible.
                final PedidoShowroom pedidoFollowup = pedido;
                if (TransactionSynchronizationManager.isSynchronizationActive()) {
                    TransactionSynchronizationManager.registerSynchronization(
                            new TransactionSynchronization() {
                                @Override
                                public void afterCommit() {
                                    pdfFollowupOrchestrator.enviarTrasPedido(pedidoFollowup);
                                }
                            });
                } else {
                    pdfFollowupOrchestrator.enviarTrasPedido(pedido);
                }
                pickitExternoService.generarAsync(pedido, clientId);

                return new CrearPedidoResponseDTO(
                        pedido.getId(),
                        pedido.getEstado(),
                        pedido.getEnviadoAt(),
                        mensajeDux != null ? mensajeDux : "Pedido enviado a DUX correctamente"
                );
            }

            // 200 OK con un mensaje que NO indica éxito: DUX rechazó el pedido.
            // No logueamos payload ni respuesta cruda (contienen PII). Ambos quedan
            // persistidos: payload reconstruible desde pedido_showroom + items,
            // respuesta cruda en pedido_showroom.respuesta_dux para diagnóstico.
            log.warn("DUX rechazó el pedido — pedidoId={}, message={}",
                    pedido.getId(), mensajeDux);
            pedido.setEstado(EstadoPedido.ERROR);
            pedidoRepository.save(pedido);
            return new CrearPedidoResponseDTO(
                    pedido.getId(),
                    EstadoPedido.ERROR,
                    null,
                    mensajeDux != null
                            ? "DUX rechazó el pedido: " + mensajeDux
                            : "DUX respondió sin éxito — revisar respuesta cruda en /pedidos"
            );
        } catch (Exception e) {
            log.error("Error enviando pedido a DUX: {}", e.getMessage(), e);
            pedido.setEstado(EstadoPedido.ERROR);
            // Guardamos el getMessage() crudo en BD para diagnóstico; al frontend
            // mandamos un mensaje legible (UserMessages traduce timeouts/red/DUX).
            pedido.setRespuestaDux(e.getMessage());
            pedidoRepository.save(pedido);
            String detalle = UserMessages.traducir(e,
                    "No se pudo enviar el pedido a DUX. El pedido quedó guardado y puede reintentarse desde Pedidos.");
            return new CrearPedidoResponseDTO(
                    pedido.getId(),
                    EstadoPedido.ERROR,
                    null,
                    "Pedido guardado localmente pero falló el envío a DUX. " + detalle
            );
        }
    }

    // =====================================================
    // Helpers
    // =====================================================

    /** Visible para que {@code CarritoService} (paquete distinto) reuse el mismo
     *  mapper sin duplicar la lógica de cálculo sin-IVA. */
    public ScanResultDTO toScanResult(ProductoCache pc) {
        BigDecimal sinIva = calcularSinIva(pc.getPvpKtGastroConIva(), pc.getPorcIva());
        return new ScanResultDTO(
                pc.getSku(),
                pc.getDescripcion(),
                pc.getPvpKtGastroConIva(),
                sinIva,
                pc.getPorcIva(),
                pc.getStockTotal(),
                pc.getHabilitado(),
                urlImagenLocal(pc.getSku()),
                pc.getSincronizadoAt()
        );
    }

    private BigDecimal calcularSinIva(BigDecimal conIva, BigDecimal porcIva) {
        if (conIva == null) return null;
        if (porcIva == null || porcIva.signum() == 0) return conIva.setScale(2, RoundingMode.HALF_UP);
        BigDecimal divisor = BigDecimal.ONE.add(porcIva.divide(CIEN, 6, RoundingMode.HALF_UP));
        return conIva.divide(divisor, 2, RoundingMode.HALF_UP);
    }

    /**
     * Precio final unitario que paga el cliente, dado el precio base con IVA
     * del producto, su % de IVA y la forma de pago elegida.
     *
     * <p>Fórmula: {@code precio_efectivo / (1 - recargo/100) × (aplicaIva ? (1 + iva/100) : 1)}.
     * El "precio efectivo" es el precio base sin IVA (lo que cobra el operador
     * cuando no hay financiación ni IVA agregado). Sobre eso se aplica:
     *  <ul>
     *    <li><b>Recargo de financiación</b>: <i>dividir</i> por (1 - recargo/100)
     *        — convención del cliente. Ej: recargo 10% → divisor 0,9 →
     *        precio_efectivo / 0,9 ≈ +11,1%, no +10%.</li>
     *    <li><b>IVA</b>: si la forma {@code aplicaIva}, multiplicar por (1+IVA).
     *        Si no, el cliente paga sin IVA (caso "transferencia sin IVA":
     *        DUX igual factura con IVA y el operador absorbe la diferencia).</li>
     *  </ul>
     *
     * <p>Sin formaPago → devuelve {@code precioBaseConIva} sin tocar.
     */
    private BigDecimal calcularPrecioFinal(BigDecimal precioBaseConIva, BigDecimal porcIva, FormaPago formaPago) {
        if (precioBaseConIva == null) return null;
        if (formaPago == null) return precioBaseConIva;
        BigDecimal precioBaseSinIva = calcularSinIva(precioBaseConIva, porcIva);
        if (precioBaseSinIva == null) return precioBaseConIva;

        BigDecimal recargoPorc = formaPago.getRecargoPorcentaje() != null
                ? formaPago.getRecargoPorcentaje() : BigDecimal.ZERO;
        BigDecimal precioRecargadoSinIva = recargoPorc.signum() > 0
                ? precioBaseSinIva.divide(
                        BigDecimal.ONE.subtract(recargoPorc.divide(CIEN, 6, RoundingMode.HALF_UP)),
                        6, RoundingMode.HALF_UP)
                : precioBaseSinIva;

        boolean aplicaIva = !Boolean.FALSE.equals(formaPago.getAplicaIva());
        if (aplicaIva && porcIva != null && porcIva.signum() > 0) {
            BigDecimal ivaFactor = BigDecimal.ONE.add(porcIva.divide(CIEN, 6, RoundingMode.HALF_UP));
            return precioRecargadoSinIva.multiply(ivaFactor).setScale(4, RoundingMode.HALF_UP);
        }
        return precioRecargadoSinIva.setScale(4, RoundingMode.HALF_UP);
    }

    /**
     * Precio CON IVA que va al comprobante DUX. Independiente del flag
     * {@code aplicaIva} de la forma — DUX siempre factura con IVA, sea cual
     * sea lo que pagó el cliente. Para "transferencia sin IVA" la diferencia
     * la absorbe el operador.
     */
    private BigDecimal calcularPrecioParaDux(BigDecimal precioBaseConIva, BigDecimal porcIva, FormaPago formaPago) {
        if (precioBaseConIva == null) return null;
        if (formaPago == null) return precioBaseConIva;
        BigDecimal precioBaseSinIva = calcularSinIva(precioBaseConIva, porcIva);
        if (precioBaseSinIva == null) return precioBaseConIva;

        BigDecimal recargoPorc = formaPago.getRecargoPorcentaje() != null
                ? formaPago.getRecargoPorcentaje() : BigDecimal.ZERO;
        BigDecimal precioRecargadoSinIva = recargoPorc.signum() > 0
                ? precioBaseSinIva.divide(
                        BigDecimal.ONE.subtract(recargoPorc.divide(CIEN, 6, RoundingMode.HALF_UP)),
                        6, RoundingMode.HALF_UP)
                : precioBaseSinIva;

        if (porcIva != null && porcIva.signum() > 0) {
            BigDecimal ivaFactor = BigDecimal.ONE.add(porcIva.divide(CIEN, 6, RoundingMode.HALF_UP));
            return precioRecargadoSinIva.multiply(ivaFactor).setScale(4, RoundingMode.HALF_UP);
        }
        return precioRecargadoSinIva.setScale(4, RoundingMode.HALF_UP);
    }

    /**
     * Arma el JSON para POST /pedido/nuevopedido según la doc DUX:
     * https://duxsoftware.readme.io/reference/crear-pedido
     *
     * Campos requeridos: fecha (ddMMyyyy), id_empresa, id_sucursal_empresa,
     * apellido_razon_social, categoria_fiscal, productos (array).
     *
     * El schema interno de productos no está expuesto en la doc pública; usamos
     * el patrón estándar DUX (cod_item + ctd + precio_uni + descuento_porcentaje).
     */
    private String construirPayloadDux(
            CrearPedidoRequestDTO request,
            FormaPago formaPago,
            Map<String, ProductoCache> caches) throws Exception {
        DuxProperties.Empresa empresa = duxProperties.empresa();
        Map<String, Object> root = new LinkedHashMap<>();

        root.put("fecha", LocalDate.now(ZONA_AR).format(DUX_FECHA));
        root.put("id_empresa", empresa.id());
        root.put("id_sucursal_empresa", empresa.idSucursal());

        root.put("apellido_razon_social", request.apellidoRazonSocial());
        if (StringUtils.hasText(request.nombre())) root.put("nombre", request.nombre());

        String catFiscal = StringUtils.hasText(request.categoriaFiscal())
                ? request.categoriaFiscal()
                : empresa.categoriaFiscalDefault();
        root.put("categoria_fiscal", catFiscal);

        if (StringUtils.hasText(request.tipoDoc())) root.put("tipo_doc", request.tipoDoc());
        if (request.nroDoc() != null) root.put("nro_doc", request.nroDoc());
        if (StringUtils.hasText(request.codigoCliente())) root.put("codigo_cliente", request.codigoCliente());
        if (StringUtils.hasText(request.telefono())) root.put("telefono", request.telefono());
        if (StringUtils.hasText(request.email())) root.put("email", request.email());
        // Mandamos la dirección en ambas keys:
        //  - `lugar_entrega`: dirección de entrega de este pedido específico (no documentada,
        //    confirmada por bisección el 2026-04-29).
        //  - `domicilio`: domicilio fiscal del cliente. Si el cliente ya existe en DUX,
        //    se sobreescribe; si no, queda como dato inicial al crearlo.
        if (StringUtils.hasText(request.domicilio())) {
            root.put("lugar_entrega", request.domicilio());
            root.put("domicilio", request.domicilio());
        }
        // NOTE: NO se puede setear el vendedor vía API en POST /pedido/nuevopedido
        // (probado el 2026-04-29 con 12 variantes de keys: id_vendedor, id_personal,
        // idVendedor, idPersonal, cod_vendedor, id_empleado, idEmpleado,
        // id_persona_personal, personal_id, vendedor_id, id_persona, vendedor).
        // DUX siempre asigna el vendedor default (probablemente atado al token
        // de API o a la config de sucursal en DUX UI). La operadora asigna el
        // vendedor manualmente en DUX al editar el comprobante.
        if (StringUtils.hasText(request.codigoProvincia())) root.put("codigo_provincia", request.codigoProvincia());
        if (StringUtils.hasText(request.idLocalidad())) root.put("id_localidad", request.idLocalidad());
        // Tag fijo para que la operadora distinga rápido los pedidos del showroom
        // en el listado de DUX. Si el frontend manda algo más específico, gana.
        root.put("referencia", StringUtils.hasText(request.referencia())
                ? request.referencia()
                : "SHOWROOM");
        // Notas internas: no-documentado en la API pública pero el campo "Observaciones"
        // del comprobante DUX existe. Si DUX lo ignora, no rompe.
        if (StringUtils.hasText(request.observaciones())) root.put("observaciones", request.observaciones());
        if (empresa.idDeposito() > 0) root.put("id_deposito", empresa.idDeposito());

        // Schema oficial de productos[] (https://duxsoftware.readme.io/reference/crear-pedido):
        //   cod_item (string, required), ctd (double, required),
        //   precio (double, required), porc_desc (double, required).
        // Los 4 son obligatorios — si falta cualquiera, DUX devuelve 200 con
        // {"message":"Debe completar todos los campos requeridos."} y NO crea el pedido.
        List<Map<String, Object>> productos = new ArrayList<>();
        for (CrearPedidoRequestDTO.Item it : request.items()) {
            Map<String, Object> d = new LinkedHashMap<>();
            d.put("cod_item", it.sku());
            d.put("ctd", it.cantidad());
            // El precio que va a DUX es siempre CON IVA (DUX factura normal,
            // independiente de si la forma aplica IVA al cliente o no). Se
            // resuelve a 4 decimales — DUX acepta hasta 6 pero 4 alcanzan
            // para montos en pesos.
            ProductoCache pc = caches != null ? caches.get(it.sku()) : null;
            BigDecimal precioBaseConIva = it.precioUnitario() != null
                    ? it.precioUnitario()
                    : (pc != null ? pc.getPvpKtGastroConIva() : BigDecimal.ZERO);
            BigDecimal porcIva = pc != null ? pc.getPorcIva() : null;
            BigDecimal precioDux = formaPago != null
                    ? calcularPrecioParaDux(precioBaseConIva, porcIva, formaPago)
                    : precioBaseConIva;
            d.put("precio", precioDux != null ? precioDux : BigDecimal.ZERO);
            d.put("porc_desc", it.descuentoPorcentaje() != null ? it.descuentoPorcentaje() : BigDecimal.ZERO);
            productos.add(d);
        }
        root.put("productos", productos);

        return objectMapper.writeValueAsString(root);
    }

    /** Texto del campo `message`/`mensaje`/`error` de la respuesta DUX, sin asumir si es éxito o error. */
    private String extraerMensajeRespuesta(String respuesta) {
        if (respuesta == null) return null;
        try {
            var node = objectMapper.readTree(respuesta);
            if (node.has("message")) return node.get("message").asText();
            if (node.has("mensaje")) return node.get("mensaje").asText();
            if (node.has("error")) return node.get("error").asText();
        } catch (Exception ignored) {
        }
        return null;
    }

    /**
     * DUX no expone códigos: el éxito se infiere del texto del mensaje. Hoy DUX
     * devuelve "Pedido ingresado con exito" en el caso feliz; cualquier otro
     * mensaje (típicamente "Debe completar todos los campos requeridos.") es error.
     * Match por substring tolerante a tildes / variaciones futuras.
     */
    private boolean mensajeIndicaExito(String mensaje) {
        if (mensaje == null) return false;
        String low = mensaje.toLowerCase(java.util.Locale.ROOT);
        return low.contains("exito") || low.contains("éxito") || low.contains("ingresado con");
    }
}
