package ar.com.leo.showroom.showroom.service;

import ar.com.leo.showroom.catalogo.entity.ProductoCache;
import ar.com.leo.showroom.catalogo.repository.ProductoCacheRepository;
import ar.com.leo.showroom.catalogo.repository.ProductoCacheSpecs;
import ar.com.leo.showroom.catalogo.service.CatalogoSyncService;
import ar.com.leo.showroom.catalogo.service.ImagenLocalService;
import ar.com.leo.showroom.common.exception.NotFoundException;
import ar.com.leo.showroom.config.service.ConfiguracionService;
import ar.com.leo.showroom.config.service.PrecioPerfilCalculator;
import ar.com.leo.showroom.config.service.EscalaDescuentoService;
import ar.com.leo.showroom.config.service.HorarioSyncSchedulerService;
import ar.com.leo.showroom.showroom.dto.CatalogoItemDTO;
import ar.com.leo.showroom.showroom.dto.CatalogoPageDTO;
import ar.com.leo.showroom.showroom.dto.EscalaDescuentoDTO;
import ar.com.leo.showroom.showroom.dto.HorarioSyncDTO;
import ar.com.leo.showroom.showroom.dto.NotificacionesAutoConfigDTO;
import ar.com.leo.showroom.showroom.dto.PickitConfigDTO;
import ar.com.leo.showroom.showroom.dto.WhatsappMensajeConfigDTO;
import ar.com.leo.showroom.showroom.dto.ProductoListItemDTO;
import ar.com.leo.showroom.showroom.dto.ProductoListPageDTO;
import ar.com.leo.showroom.showroom.dto.ScanResultDTO;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Pageable;
import org.springframework.data.domain.Sort;
import org.springframework.data.jpa.domain.Specification;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.math.BigDecimal;
import java.util.*;
import java.util.stream.Collectors;

@Slf4j
@Service
@RequiredArgsConstructor
public class ShowroomService {

    private final CatalogoSyncService catalogoSync;
    private final ProductoCacheRepository productoCacheRepository;
    private final ImagenLocalService imagenLocalService;
    private final EscalaDescuentoService escalaDescuentoService;
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

    /** Rubros cuyos productos cotizan sin IVA (precio base = PVP sin IVA). */
    public List<String> getRubrosSinIva() {
        return configuracionService.getRubrosSinIva();
    }

    public List<String> saveRubrosSinIva(List<String> rubros) {
        return configuracionService.saveRubrosSinIva(rubros);
    }


    /**
     * Rubros distintos cacheados — popula el dropdown del filtro de la
     * pantalla {@code /productos}. Una sola query sobre el cache.
     */
    public List<String> listarRubrosDistintos() {
        return productoCacheRepository.findDistinctRubros();
    }

    /**
     * Whitelist de campos por los que el operador puede ordenar los resultados
     * de búsqueda del catálogo (showroom + presupuestador). Mapea el id que manda
     * el front a la propiedad de la entity {@link ProductoCache}. "precio" =
     * PVP con IVA. Sin entrada → se cae al orden por relevancia/SKU.
     */
    private static final Map<String, String> SORT_CATALOGO = Map.of(
            "descripcion", "descripcion",
            "precio", "pvpKtGastroConIva"
    );

    /**
     * Búsqueda paginada en el cache local (sin tocar DUX).
     * Usada por la pantalla de generación de etiquetas QR, el showroom y el
     * presupuestador. {@code sortField} ("descripcion"/"precio") + {@code sortOrder}
     * ("asc"/"desc") son opcionales: si vienen, el operador eligió el orden y
     * manda el Pageable; si no, se usa el ranking por relevancia.
     */
    public CatalogoPageDTO buscarCatalogo(String q, int page, int size, String sortField, String sortOrder) {
        return buscarCatalogo(q, page, size, sortField, sortOrder, null);
    }

    /** Variante con filtro por proveedor (nombre exacto). {@code proveedor} null/
     *  blank = sin filtro. */
    public CatalogoPageDTO buscarCatalogo(String q, int page, int size, String sortField,
                                          String sortOrder, String proveedor) {
        int pageSafe = Math.max(0, page);
        int sizeSafe = Math.min(Math.max(size, 1), 200);
        List<String> tokens = ProductoCacheSpecs.tokenizar(q);
        // Orden: si el operador eligió un campo (producto/precio), manda el
        // Pageable y se desactiva el ranking por relevancia. Si no, se mantiene
        // el comportamiento histórico: ranking por relevancia cuando hay tokens,
        // o SKU asc cuando la búsqueda está vacía.
        boolean sortExplicito = sortField != null && SORT_CATALOGO.containsKey(sortField);
        Pageable pageable;
        boolean aplicarRanking;
        if (sortExplicito) {
            // Desempate por SKU para que la paginación sea ESTABLE cuando hay
            // descripciones/precios repetidos: sin él, los ítems empatados pueden
            // saltar entre páginas al traer "cargar más".
            Sort sort = ar.com.leo.showroom.common.util.SortUtils
                    .resolver(SORT_CATALOGO, sortField, sortOrder, "descripcion")
                    .and(Sort.by(Sort.Direction.ASC, "sku"));
            pageable = PageRequest.of(pageSafe, sizeSafe, sort);
            aplicarRanking = false;
        } else if (tokens.isEmpty()) {
            pageable = PageRequest.of(pageSafe, sizeSafe, Sort.by(Sort.Direction.ASC, "sku"));
            aplicarRanking = false;
        } else {
            pageable = PageRequest.of(pageSafe, sizeSafe);
            aplicarRanking = true;
        }
        Specification<ProductoCache> spec = ProductoCacheSpecs.matchTokens(tokens, aplicarRanking)
                .and(ProductoCacheSpecs.porProveedor(proveedor));
        Page<ProductoCache> resultado = productoCacheRepository.findAll(spec, pageable);
        List<CatalogoItemDTO> items = resultado.getContent().stream()
                .map(this::toCatalogoItem)
                .toList();
        return new CatalogoPageDTO(items, resultado.getTotalElements(), pageSafe, sizeSafe);
    }

    /** Proveedores distintos del catálogo (no vacíos), alfabético. Pobla el
     *  dropdown del filtro por proveedor del showroom/presupuestador.
     *
     *  <p>Si {@code q} trae texto, devuelve SOLO los proveedores de los productos
     *  que matchean esa búsqueda (mismo criterio de tokens que {@code buscarCatalogo})
     *  — así el filtro muestra proveedores relevantes a lo buscado. Sin {@code q}
     *  devuelve todos (query eficiente con DISTINCT en BD). */
    public List<String> listarProveedoresCatalogo(String q) {
        List<String> tokens = ProductoCacheSpecs.tokenizar(q);
        if (tokens.isEmpty()) {
            return productoCacheRepository.findDistinctProveedores();
        }
        Specification<ProductoCache> spec = ProductoCacheSpecs.matchTokens(tokens, false);
        return productoCacheRepository.findAll(spec).stream()
                .map(ProductoCache::getProveedor)
                .filter(StringUtils::hasText)
                .distinct()
                .sorted(String.CASE_INSENSITIVE_ORDER)
                .toList();
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
                pc.getRubro(),
                sinIva,
                pc.getPvpKtGastroConIva(),
                pc.getPorcIva(),
                pc.getHabilitado(),
                urlImagenLocal(pc.getSku()),
                pc.getStockTotal(),
                pc.getProveedor());
    }

    /**
     * Búsqueda paginada con filtros para la pantalla de listado de productos.
     * Versión enriquecida de buscarCatalogo: incluye stock, precio c/IVA y
     * timestamp de última sync.
     */
    /** Whitelist de campos ordenables del listado de productos. */
    private static final Map<String, String> SORT_PRODUCTOS = Map.ofEntries(
            Map.entry("sku", "sku"),
            Map.entry("descripcion", "descripcion"),
            Map.entry("rubro", "rubro"),
            Map.entry("pvpKtGastroConIva", "pvpKtGastroConIva"),
            Map.entry("pvpKtGastroSinIva", "pvpKtGastroConIva"), // mismo campo (sin-IVA es derivado)
            Map.entry("porcIva", "porcIva"),
            Map.entry("stockTotal", "stockTotal"),
            Map.entry("habilitado", "habilitado"),
            Map.entry("sincronizadoAt", "sincronizadoAt"),
            Map.entry("proveedor", "proveedor")
    );

    public ProductoListPageDTO buscarProductos(
            String q,
            boolean soloDeshabilitados,
            boolean soloSinStock,
            String rubro,
            String proveedor,
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
            // Desempate por SKU para paginación ESTABLE ante valores repetidos
            // (ej. ordenar por rubro/habilitado) — sin esto los ítems empatados
            // saltan entre páginas. Si ya se ordena por SKU, no se duplica.
            Sort sort = "sku".equals(campo)
                    ? Sort.by(dir, "sku")
                    : Sort.by(dir, campo).and(Sort.by(Sort.Direction.ASC, "sku"));
            pageable = PageRequest.of(pageSafe, sizeSafe, sort);
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
        if (rubro != null && !rubro.isBlank()) spec = spec.and(ProductoCacheSpecs.porRubro(rubro));
        if (proveedor != null && !proveedor.isBlank()) spec = spec.and(ProductoCacheSpecs.porProveedor(proveedor));

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

    private ProductoListItemDTO toProductoListItem(ProductoCache pc, List<String> codigosBarra) {
        List<String> eans = codigosBarra.stream().sorted().toList();
        return new ProductoListItemDTO(
                pc.getSku(),
                pc.getDescripcion(),
                pc.getRubro(),
                pc.getPvpKtGastroConIva(),
                calcularSinIva(pc.getPvpKtGastroConIva(), pc.getPorcIva()),
                pc.getPorcIva(),
                pc.getStockTotal(),
                pc.getHabilitado(),
                urlImagenLocal(pc.getSku()),
                eans,
                pc.getSincronizadoAt(),
                pc.getProveedor()
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
                pc.getRubro(),
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
        return PrecioPerfilCalculator.calcularSinIva(conIva, porcIva);
    }

}
