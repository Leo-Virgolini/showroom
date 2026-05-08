package ar.com.leo.showroom.showroom.service;

import ar.com.leo.showroom.catalogo.entity.ProductoCache;
import ar.com.leo.showroom.catalogo.repository.LocalidadRepository;
import ar.com.leo.showroom.catalogo.repository.ProductoCacheRepository;
import ar.com.leo.showroom.catalogo.repository.ProvinciaRepository;
import ar.com.leo.showroom.catalogo.service.CatalogoSyncService;
import ar.com.leo.showroom.catalogo.service.ImagenLocalService;
import ar.com.leo.showroom.common.exception.ConflictException;
import ar.com.leo.showroom.common.exception.NotFoundException;
import ar.com.leo.showroom.config.entity.EscalaDescuento;
import ar.com.leo.showroom.config.entity.HorarioSync;
import ar.com.leo.showroom.config.service.ConfiguracionService;
import ar.com.leo.showroom.config.service.EscalaDescuentoService;
import ar.com.leo.showroom.config.service.HorarioSyncSchedulerService;
import ar.com.leo.showroom.dux.config.DuxProperties;
import ar.com.leo.showroom.dux.service.DuxClient;
import ar.com.leo.showroom.pedido.entity.EstadoPedido;
import ar.com.leo.showroom.pedido.entity.PedidoShowroom;
import ar.com.leo.showroom.pedido.entity.PedidoShowroomItem;
import ar.com.leo.showroom.pedido.repository.PedidoShowroomRepository;
import ar.com.leo.showroom.picking.PickingEmailService;
import ar.com.leo.showroom.showroom.dto.CatalogoItemDTO;
import ar.com.leo.showroom.showroom.dto.CatalogoPageDTO;
import ar.com.leo.showroom.showroom.dto.CrearPedidoRequestDTO;
import ar.com.leo.showroom.showroom.dto.CrearPedidoResponseDTO;
import ar.com.leo.showroom.showroom.dto.EscalaDescuentoDTO;
import ar.com.leo.showroom.showroom.dto.HorarioSyncDTO;
import ar.com.leo.showroom.showroom.dto.PedidoDetailDTO;
import ar.com.leo.showroom.showroom.dto.PedidoItemDTO;
import ar.com.leo.showroom.showroom.dto.PedidoListItemDTO;
import ar.com.leo.showroom.showroom.dto.PedidoListPageDTO;
import ar.com.leo.showroom.showroom.dto.ProductoListItemDTO;
import ar.com.leo.showroom.showroom.dto.ProductoListPageDTO;
import ar.com.leo.showroom.showroom.dto.ScanResultDTO;
import jakarta.transaction.Transactional;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;
import tools.jackson.databind.ObjectMapper;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.util.*;

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
    private final ProductoCacheRepository productoCacheRepository;
    private final ObjectMapper objectMapper;
    private final DuxProperties duxProperties;
    private final PickingEmailService pickingEmailService;
    private final ImagenLocalService imagenLocalService;
    private final ProvinciaRepository provinciaRepository;
    private final LocalidadRepository localidadRepository;
    private final EscalaDescuentoService escalaDescuentoService;
    private final HorarioSyncSchedulerService horarioSyncService;
    private final ConfiguracionService configuracionService;

    @Value("${showroom.cache.stock-stale-minutes:15}")
    private int stockStaleMinutes;

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

    /** Destinatario actual del email de picking (DB o default de properties). */
    public String getEmailPicking() {
        return configuracionService.getEmailPickingTo();
    }

    /** Persiste el destinatario del email de picking. Devuelve el valor efectivo. */
    public String setEmailPicking(String email) {
        return configuracionService.setEmailPickingTo(email);
    }


    /**
     * Búsqueda paginada en el cache local (sin tocar DUX).
     * Usada por la pantalla de generación de etiquetas QR.
     */
    public CatalogoPageDTO buscarCatalogo(String q, int page, int size) {
        int pageSafe = Math.max(0, page);
        int sizeSafe = Math.min(Math.max(size, 1), 200);
        Page<ProductoCache> resultado = productoCacheRepository.buscar(
                q == null ? null : q.trim(),
                PageRequest.of(pageSafe, sizeSafe)
        );
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
        String campo = SORT_PRODUCTOS.getOrDefault(sortField, "sku");
        Sort.Direction direccion = "desc".equalsIgnoreCase(sortOrder)
                ? Sort.Direction.DESC
                : Sort.Direction.ASC;
        Sort sort = Sort.by(direccion, campo);
        Page<ProductoCache> resultado = productoCacheRepository.buscarConFiltros(
                q == null ? null : q.trim(),
                soloDeshabilitados,
                soloSinStock,
                PageRequest.of(pageSafe, sizeSafe, sort)
        );
        List<ProductoListItemDTO> items = resultado.getContent().stream()
                .map(this::toProductoListItem)
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
                q == null ? null : q.trim(),
                estado,
                desde,
                hasta,
                PageRequest.of(pageSafe, sizeSafe, sort)
        );
        List<PedidoListItemDTO> items = resultado.getContent().stream()
                .map(this::toPedidoListItem)
                .toList();
        return new PedidoListPageDTO(items, resultado.getTotalElements(), pageSafe, sizeSafe);
    }

    public PedidoDetailDTO obtenerPedido(Long id) {
        PedidoShowroom p = pedidoRepository.findById(id)
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

    private PedidoListItemDTO toPedidoListItem(PedidoShowroom p) {
        int cantidadItems = p.getItems() == null ? 0 : p.getItems().size();
        return new PedidoListItemDTO(
                p.getId(),
                p.getCreadoAt(),
                p.getEnviadoAt(),
                p.getAnuladoAt(),
                p.getEstado(),
                p.getNroDoc(),
                p.getApellidoRazonSocial(),
                p.getNombre(),
                p.getTotal(),
                p.getTotalSinIva(),
                p.getDescuentoPorcentaje(),
                cantidadItems
        );
    }

    private ProductoListItemDTO toProductoListItem(ProductoCache pc) {
        List<String> eans = pc.getCodigosBarra() == null
                ? List.of()
                : pc.getCodigosBarra().stream().sorted().toList();
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
    public CrearPedidoResponseDTO crearPedido(CrearPedidoRequestDTO request) {
        // Si todos los items vienen con el mismo descuento (típico — el frontend manda
        // el descuento global), lo guardamos a nivel pedido también para que la pantalla
        // de listado lo muestre sin tener que iterar items.
        BigDecimal descuentoGlobal = request.items().stream()
                .map(CrearPedidoRequestDTO.Item::descuentoPorcentaje)
                .filter(Objects::nonNull)
                .findFirst()
                .orElse(null);

        PedidoShowroom pedido = PedidoShowroom.builder()
                .creadoAt(Instant.now())
                .estado(EstadoPedido.PENDIENTE)
                .observaciones(request.observaciones())
                .apellidoRazonSocial(request.apellidoRazonSocial())
                .nombre(StringUtils.hasText(request.nombre()) ? request.nombre() : null)
                .tipoDoc(request.tipoDoc())
                .nroDoc(request.nroDoc())
                .telefono(request.telefono())
                .email(request.email())
                .domicilio(request.domicilio())
                .codigoProvincia(request.codigoProvincia())
                .idLocalidad(request.idLocalidad())
                .descuentoPorcentaje(descuentoGlobal)
                .build();

        BigDecimal total = BigDecimal.ZERO;
        BigDecimal totalSinIva = BigDecimal.ZERO;
        Map<String, ProductoCache> caches = catalogoSync.obtenerPorSkus(
                request.items().stream().map(CrearPedidoRequestDTO.Item::sku).toList()
        );

        for (CrearPedidoRequestDTO.Item it : request.items()) {
            ProductoCache pc = caches.get(it.sku());
            BigDecimal precio = it.precioUnitario() != null
                    ? it.precioUnitario()
                    : (pc != null ? pc.getPvpKtGastroConIva() : null);
            String descripcion = pc != null ? pc.getDescripcion() : null;
            BigDecimal porcIva = pc != null ? pc.getPorcIva() : null;

            PedidoShowroomItem item = PedidoShowroomItem.builder()
                    .pedido(pedido)
                    .sku(it.sku())
                    .descripcion(descripcion)
                    .cantidad(it.cantidad())
                    .precioUnitario(precio)
                    .porcIva(porcIva)
                    .build();
            pedido.getItems().add(item);

            if (precio != null) {
                BigDecimal cant = BigDecimal.valueOf(it.cantidad());
                total = total.add(precio.multiply(cant));
                BigDecimal precioSinIva = calcularSinIva(precio, porcIva);
                if (precioSinIva != null) {
                    totalSinIva = totalSinIva.add(precioSinIva.multiply(cant));
                }
            }
        }
        pedido.setTotal(total.setScale(2, RoundingMode.HALF_UP));
        pedido.setTotalSinIva(totalSinIva.setScale(2, RoundingMode.HALF_UP));
        pedidoRepository.save(pedido);

        try {
            String body = construirPayloadDux(request);
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

                // Mandar el XLSX + PDF presupuesto por email — async, no bloquea la
                // respuesta. Si falla (SMTP roto, config faltante, etc.), solo se
                // loguea el error: el pedido ya está en DUX, no se revierte.
                pickingEmailService.enviarAsync(pedido);

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
            pedido.setRespuestaDux(e.getMessage());
            pedidoRepository.save(pedido);
            return new CrearPedidoResponseDTO(
                    pedido.getId(),
                    EstadoPedido.ERROR,
                    null,
                    "Pedido guardado localmente pero falló envío a DUX: " + e.getMessage()
            );
        }
    }

    // =====================================================
    // Helpers
    // =====================================================

    private ScanResultDTO toScanResult(ProductoCache pc) {
        BigDecimal sinIva = calcularSinIva(pc.getPvpKtGastroConIva(), pc.getPorcIva());

        boolean stockStale = pc.getSincronizadoAt() == null
                || Duration.between(pc.getSincronizadoAt(), Instant.now())
                        .toMinutes() >= stockStaleMinutes;

        return new ScanResultDTO(
                pc.getSku(),
                pc.getDescripcion(),
                pc.getPvpKtGastroConIva(),
                sinIva,
                pc.getPorcIva(),
                pc.getStockTotal(),
                pc.getHabilitado(),
                urlImagenLocal(pc.getSku()),
                pc.getSincronizadoAt(),
                stockStale
        );
    }

    private BigDecimal calcularSinIva(BigDecimal conIva, BigDecimal porcIva) {
        if (conIva == null) return null;
        if (porcIva == null || porcIva.signum() == 0) return conIva.setScale(2, RoundingMode.HALF_UP);
        BigDecimal divisor = BigDecimal.ONE.add(porcIva.divide(CIEN, 6, RoundingMode.HALF_UP));
        return conIva.divide(divisor, 2, RoundingMode.HALF_UP);
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
    private String construirPayloadDux(CrearPedidoRequestDTO request) throws Exception {
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
        // Vendedor: NO se puede setear vía API en POST /pedido/nuevopedido (probado el 2026-04-29).
        // Probamos 12 variantes de keys (id_vendedor, id_personal, idVendedor, idPersonal,
        // cod_vendedor, id_empleado, idEmpleado, id_persona_personal, personal_id, vendedor_id,
        // id_persona, vendedor) y DUX siguió asignando el vendedor default (probablemente atado
        // al token de API o a config de sucursal en DUX UI). El config `dux.empresa.id-vendedor`
        // queda en application.properties por si alguna versión futura de DUX expone el campo.
        // La operadora asigna el vendedor manualmente en DUX al editar el comprobante.
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
            d.put("precio", it.precioUnitario() != null ? it.precioUnitario() : BigDecimal.ZERO);
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
