package ar.com.leo.showroom.pedido.service;

import ar.com.leo.showroom.auth.repository.UsuarioRepository;
import ar.com.leo.showroom.auth.service.UsuarioService;
import ar.com.leo.showroom.catalogo.entity.ProductoCache;
import ar.com.leo.showroom.catalogo.repository.LocalidadRepository;
import ar.com.leo.showroom.catalogo.repository.ProvinciaRepository;
import ar.com.leo.showroom.catalogo.service.CatalogoSyncService;
import ar.com.leo.showroom.catalogo.service.ImagenLocalService;
import ar.com.leo.showroom.cliente.event.ClienteMovimientoEvent;
import ar.com.leo.showroom.cliente.service.ClienteMasterService;
import ar.com.leo.showroom.common.exception.ConflictException;
import ar.com.leo.showroom.common.exception.NotFoundException;
import ar.com.leo.showroom.common.exception.UserMessages;
import ar.com.leo.showroom.common.util.SortUtils;
import ar.com.leo.showroom.config.entity.FormaPago;
import ar.com.leo.showroom.config.service.FormaPagoService;
import ar.com.leo.showroom.config.service.PrecioPerfilCalculator;
import ar.com.leo.showroom.dux.config.DuxProperties;
import ar.com.leo.showroom.dux.service.DuxClient;
import ar.com.leo.showroom.events.SyncEventService;
import ar.com.leo.showroom.pedido.entity.EstadoPedido;
import ar.com.leo.showroom.pedido.entity.PedidoShowroom;
import ar.com.leo.showroom.pedido.entity.PedidoShowroomItem;
import ar.com.leo.showroom.pedido.repository.PedidoShowroomRepository;
import ar.com.leo.showroom.picking.PdfFollowupOrchestrator;
import ar.com.leo.showroom.pickit_externo.PickitExternoService;
import ar.com.leo.showroom.presupuesto.repository.PresupuestoComercialRepository;
import ar.com.leo.showroom.sesion.repository.SesionShowroomRepository;
import ar.com.leo.showroom.sesion.service.SesionShowroomService;
import ar.com.leo.showroom.showroom.dto.ConversionProductoDTO;
import ar.com.leo.showroom.showroom.dto.CrearPedidoRequestDTO;
import ar.com.leo.showroom.showroom.dto.CrearPedidoResponseDTO;
import ar.com.leo.showroom.showroom.dto.EstadisticaProductoDTO;
import ar.com.leo.showroom.showroom.dto.EstadisticasHistorialDTO;
import ar.com.leo.showroom.showroom.dto.PedidoDetailDTO;
import ar.com.leo.showroom.showroom.dto.PedidoItemDTO;
import ar.com.leo.showroom.showroom.dto.PedidoListItemDTO;
import ar.com.leo.showroom.showroom.dto.PedidoListPageDTO;
import ar.com.leo.showroom.showroom.dto.TasaConversionGlobalDTO;
import jakarta.transaction.Transactional;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Pageable;
import org.springframework.data.domain.Sort;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.util.StringUtils;
import tools.jackson.databind.ObjectMapper;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.net.SocketTimeoutException;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * Ciclo de vida del pedido del showroom: alta (con envío a DUX), listado
 * paginado, detalle, anulación/reactivación y estadísticas del historial.
 *
 * <p>Se extrajo de {@code ShowroomService} (que quedó enfocado en scan/catálogo/
 * configuración) para aislar el flujo de facturación a DUX. Los DTOs siguen en
 * {@code showroom.dto} (contrato compartido con el controller). Los wrappers de
 * cálculo de precio por perfil se duplican como privados acá porque delegan a
 * {@link PrecioPerfilCalculator} (bean compartido) — no introducen lógica nueva.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class PedidoService {

    private static final DateTimeFormatter DUX_FECHA = DateTimeFormatter.ofPattern("ddMMyyyy");
    /** DUX espera la fecha en horario Argentina, no en UTC del servidor. */
    private static final ZoneId ZONA_AR = ZoneId.of("America/Argentina/Buenos_Aires");

    /**
     * Orden del "top por conversión": mayor % de conversión primero; ante igual
     * % (muy común, porque hay muchos productos en 0%), desempata por sesiones
     * con compra y luego por sesiones escaneadas — todo descendente.
     *
     * <p>El desempate final por {@code sesionesEscaneadas} es clave: ante igual
     * % (en especial 0%), prioriza los productos MÁS mirados. Un producto muy
     * escaneado y nunca comprado es justo la señal "vidriera" que la tabla
     * busca destacar.
     *
     * <p>Construido en ascendente y revertido UNA sola vez al final: encadenar
     * {@code .reversed()} después de cada criterio invierte el comparator
     * compuesto entero en cada llamada.
     */
    static final Comparator<ConversionProductoDTO> ORDEN_CONVERSION =
            Comparator.comparingDouble(ConversionProductoDTO::porcentaje)
                    .thenComparingLong(ConversionProductoDTO::sesionesConCompra)
                    .thenComparingLong(ConversionProductoDTO::sesionesEscaneadas)
                    .reversed();

    /** Whitelist de campos por los que se permite ordenar el listado de pedidos.
     *  Mapea el id de columna del frontend al atributo de la entity (evita
     *  inyección vía sort field). */
    private static final Map<String, String> SORT_PEDIDOS = Map.ofEntries(
            // Número interno del pedido (columna "#" del listado).
            Map.entry("id", "id"),
            Map.entry("creadoAt", "creadoAt"),
            Map.entry("estado", "estado"),
            Map.entry("nroDoc", "nroDoc"),
            // El header "Cliente" ordena por la razón social (`apellidoRazonSocial`),
            // que es el dato principal que muestra la columna. La clave "nombre" es
            // el id de columna que manda el front; se mantiene por compatibilidad.
            Map.entry("nombre", "apellidoRazonSocial"),
            // La columna "Operador" usa `creadoPor` en el DTO; ordena por el
            // campo directo `usuarioId` de la entity (agrupa por operador).
            Map.entry("creadoPor", "usuarioId"),
            Map.entry("formaPagoNombre", "formaPagoNombre"),
            Map.entry("descuentoPorcentaje", "descuentoPorcentaje"),
            Map.entry("totalSinIva", "totalSinIva"),
            Map.entry("total", "total")
    );

    private final PedidoShowroomRepository pedidoRepository;
    private final SesionShowroomRepository sesionRepository;
    private final PresupuestoComercialRepository presupuestoComercialRepository;
    private final UsuarioRepository usuarioRepository;
    private final UsuarioService usuarioService;
    private final FormaPagoService formaPagoService;
    private final CatalogoSyncService catalogoSync;
    private final DuxProperties duxProperties;
    private final DuxClient duxClient;
    private final ObjectMapper objectMapper;
    private final ClienteMasterService clienteMasterService;
    private final org.springframework.context.ApplicationEventPublisher eventPublisher;
    private final SesionShowroomService sesionShowroomService;
    private final PdfFollowupOrchestrator pdfFollowupOrchestrator;
    private final PickitExternoService pickitExternoService;
    private final PrecioPerfilCalculator precioPerfilCalculator;
    private final ProvinciaRepository provinciaRepository;
    private final LocalidadRepository localidadRepository;
    private final ImagenLocalService imagenLocalService;
    private final SyncEventService eventService;

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
        Sort sort = SortUtils.resolver(SORT_PEDIDOS, sortField, sortOrder, "creadoAt");
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
        // Bulk lookup del origen del pedido (presupuesto o sesión de showroom)
        // para la columna "Origen" del listado. Dos queries IN, mapas en memoria.
        // Reusa `ids` (los mismos ids de la página ya calculados arriba).
        Map<Long, Long> presupuestoPorPedido = new HashMap<>();
        if (!ids.isEmpty()) {
            for (Object[] row : presupuestoComercialRepository.findPresupuestoIdsByPedidoIds(ids)) {
                if (row[0] != null) presupuestoPorPedido.put((Long) row[0], (Long) row[1]);
            }
        }
        Map<Long, Long> sesionPorPedido = new HashMap<>();
        if (!ids.isEmpty()) {
            for (Object[] row : sesionRepository.findSesionIdsByPedidoIds(ids)) {
                if (row[0] != null) sesionPorPedido.put((Long) row[0], (Long) row[1]);
            }
        }
        List<PedidoListItemDTO> items = resultado.getContent().stream()
                .map(p -> toPedidoListItem(p, cantidadItems.getOrDefault(p.getId(), 0), operadores,
                        presupuestoPorPedido.get(p.getId()), sesionPorPedido.get(p.getId())))
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
        return usuarioService.nombresPorId(ids);
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
        long conPresupuesto = sesionRepository.contarConPresupuesto(desde, hasta);

        // Tasa de conversión por producto: numerador = sesiones únicas que
        // escanearon X y compraron X; denominador = sesiones únicas que
        // escanearon X. Da un % real (0..100) que responde "de los clientes
        // que vieron este producto, ¿qué % lo terminó comprando?".
        //
        // Filtramos productos con muy pocos scans (<2) para evitar ruido — un
        // SKU escaneado 1 vez y comprado 1 vez daría 100% pero no es
        // estadísticamente relevante. Orden: ver ORDEN_CONVERSION (% desc, con
        // desempate por sesiones con compra y por sesiones escaneadas).
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
                .sorted(ORDEN_CONVERSION)
                .limit(limitSafe)
                .toList();

        return new EstadisticasHistorialDTO(
                sesionRepository.topEscaneados(desde, hasta, limit),
                pedidoRepository.topComprados(desde, hasta, limit),
                new TasaConversionGlobalDTO(finalizadas, conPedido, conPresupuesto),
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
                        it.getPrecioListaConIva(),
                        it.getPorcIva(),
                        it.getAplicaIva(),
                        it.getDescuentoPorcentaje(),
                        imagenLocalService.urlPublica(it.getSku()),
                        it.getComentarios(),
                        it.getRubro()))
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
                Map.of("pedidoId", id, "estado", EstadoPedido.ANULADO.name()));
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
     * <p>NO toca DUX — si el pedido estaba ENVIADO (cargado en DUX) al anular, igual
     * seguía existiendo del lado de DUX (la anulación local nunca lo borró allá).
     * Revertir simplemente sincroniza el sistema con la verdad de DUX.
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
                Map.of("pedidoId", id, "estado", estadoOriginal.name()));
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
                                               Map<Long, String> usernamesByUsuarioId,
                                               Long presupuestoId, Long sesionId) {
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
                creadoPor,
                presupuestoId,
                sesionId
        );
    }

    @Transactional
    public CrearPedidoResponseDTO crearPedido(CrearPedidoRequestDTO request, String clientId, String username) {
        return crearPedido(request, clientId, username, false);
    }

    /**
     * Variante que permite tratar el alta como una REGENERACIÓN/EDICIÓN de pedido:
     * cuando {@code tratarComoRegeneracion} es true se omite la asociación de la
     * sesión de atención y el PDF de follow-up (igual que un pedido de presupuesto),
     * sin necesidad de mandar {@code origenPresupuesto} en el request. El re-vínculo
     * de presupuesto/sesión al pedido nuevo lo hace {@code EdicionPedidoService}.
     */
    @Transactional
    public CrearPedidoResponseDTO crearPedido(CrearPedidoRequestDTO request, String clientId, String username, boolean tratarComoRegeneracion) {
        // Combina el flag histórico del request con la instrucción explícita de
        // regeneración. Controla el bloque sesión/follow-up (abajo) sin exponer
        // "origenPresupuesto" al llamador de edición de pedidos.
        boolean omitirAtencion = tratarComoRegeneracion || request.origenPresupuesto();

        // El descuento a nivel pedido se calcula como el % EFECTIVO sobre el
        // subtotal (monto descontado / subtotal bruto), recién después de iterar
        // los ítems — coincide con descuentos individuales mixtos, no solo con el
        // descuento global uniforme. Se setea más abajo (ver `descuentoEfectivo`).

        // Resolver forma de pago. Si formaPagoId viene, lo buscamos.
        // 400 si la forma_pago no existe — el frontend no debería mandar ids
        // stale; si pasa, es un bug de la UI.
        FormaPago formaPago = null;
        if (request.formaPagoId() != null) {
            formaPago = formaPagoService.obtenerPorId(request.formaPagoId())
                    .orElseThrow(() -> new IllegalArgumentException(
                            "Forma de pago no encontrada: " + request.formaPagoId()));
        }
        // Snapshot de cabecera del perfil MENAJE (base). Sirve de default para el
        // builder y de fallback cuando el pedido mezcla perfiles (menaje +
        // maquinaria) — caso en que un único recargo/IVA de cabecera es
        // intrínsecamente ambiguo. Para pedidos homogéneos, la cabecera se
        // re-deriva del perfil realmente aplicado tras el loop (ver más abajo).
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
                .clienteTelefonoNormalizado(ClienteMasterService.normalizar(request.telefono()))
                .email(request.email())
                .rubro(request.rubro())
                .domicilio(request.domicilio())
                .codigoProvincia(request.codigoProvincia())
                .idLocalidad(request.idLocalidad())
                .formaPagoId(formaPago != null ? formaPago.getId() : null)
                .formaPagoNombre(formaPago != null ? formaPago.getNombre() : null)
                .recargoPorcentaje(formaPago != null ? recargoPorc : null)
                .cantidadCuotas(formaPago != null ? formaPago.getCantidadCuotas() : null)
                .formaPagoAplicaIva(formaPago != null ? aplicaIva : null)
                .build();

        BigDecimal total = BigDecimal.ZERO;
        BigDecimal totalSinIva = BigDecimal.ZERO;
        BigDecimal totalSinRecargo = BigDecimal.ZERO;
        // Subtotal bruto (con recargo, SIN descuento) — base para el % de
        // descuento efectivo del pedido que se calcula tras el loop.
        BigDecimal subtotalBruto = BigDecimal.ZERO;
        Map<String, ProductoCache> caches = catalogoSync.obtenerPorSkus(
                request.items().stream().map(CrearPedidoRequestDTO.Item::sku).toList()
        );
        Set<String> rubrosMaq = rubrosMaquinariaNormalizados();
        // Perfiles (recargo/IVA) efectivamente aplicados a los ítems. En un pedido
        // homogéneo el set queda con un único valor y ese es el snapshot correcto
        // de cabecera; si el pedido mezcla menaje y maquinaria, el set tiene 2
        // valores y dejamos el default menaje (ambiguo por diseño).
        Set<BigDecimal> recargosPerfilUsados = new HashSet<>();
        Set<Boolean> ivasPerfilUsados = new HashSet<>();

        String skuGenerico = duxProperties.skuProductoGenerico();
        for (CrearPedidoRequestDTO.Item it : request.items()) {
            boolean esGenerico = skuGenerico != null && skuGenerico.equals(it.sku());
            ProductoCache pc = caches.get(it.sku());
            BigDecimal precioBaseConIva = it.precioUnitario() != null
                    ? it.precioUnitario()
                    : (pc != null ? pc.getPvpKtGastroConIva() : null);
            // Para genéricos preferimos la descripción tipeada por el operador
            // (que viaja en `comentarios`) por encima de lo que diga el cache
            // del SKU comodín. Para items normales, el cache es la fuente.
            String descripcion;
            if (esGenerico && StringUtils.hasText(it.comentarios())) {
                descripcion = it.comentarios().trim();
            } else {
                descripcion = pc != null ? pc.getDescripcion() : null;
            }
            // Genéricos: el porcIva lo eligió el operador en el dialog y
            // viaja en el item. Si no vino (defensive — siempre debería venir
            // para genéricos), asumimos 21. Items normales toman el porcIva
            // del cache — la fuente de verdad para el producto real.
            BigDecimal porcIva = esGenerico
                    ? (it.porcIva() != null ? it.porcIva() : PrecioPerfilCalculator.IVA_DEFAULT)
                    : (pc != null ? pc.getPorcIva() : null);

            // Perfil (Normal/Maquinaria) según el rubro del ítem. Para pedidos de
            // presupuesto NO caemos al rubro del cache: usamos el rubro tal como
            // lo guardó el presupuesto (null → menaje), para reproducir el perfil
            // con que se cotizó cada ítem. En el flujo showroom normal sí caemos
            // al cache cuando el item no trae rubro (genéricos).
            String rubroItem = request.origenPresupuesto()
                    ? it.rubro()
                    : (it.rubro() != null ? it.rubro() : (pc != null ? pc.getRubro() : null));
            boolean esMaq = resolverEsMaq(
                    request.origenPresupuesto(), it.precioReferenciaConIva(), rubroItem, rubrosMaq);
            BigDecimal recargoItem = recargoPerfil(formaPago, esMaq);
            // El perfil de IVA sale de la forma ELEGIDA (según el rubro del ítem),
            // igual para showroom y para pedidos de presupuesto: el operador elige
            // con qué forma paga el cliente al crear el pedido y el IVA es parte de
            // esa forma.
            boolean aplicaIvaItem = aplicaIvaPerfil(formaPago, esMaq);
            if (formaPago != null) {
                recargosPerfilUsados.add(recargoItem);
                ivasPerfilUsados.add(aplicaIvaItem);
            }

            // Precio que paga el cliente (BRUTO, sin el descuento de la línea),
            // calculado con la forma de pago ELEGIDA sobre el precio de lista con
            // IVA. Para pedidos de presupuesto, `precioBaseConIva` es el PVP
            // CONGELADO del presupuesto (it.precioUnitario), de modo que el
            // recargo/descuento de la forma elegida se aplica sobre lo cotizado —
            // igual que el preview del diálogo. NO se usa `precioReferencia` (que
            // ya traía aplicado el descuento de la forma de referencia/Efectivo y
            // por eso ignoraba la forma elegida).
            BigDecimal precioFinal = calcularPrecioFinal(precioBaseConIva, porcIva, recargoItem, aplicaIvaItem);

            // Descuento de la línea: el % que también viaja a DUX como porc_desc.
            // factorDesc = 1 − desc/100. El precioUnitario se persiste BRUTO; el
            // descuento se guarda aparte y se aplica a los totales.
            BigDecimal descItem = it.descuentoPorcentaje() != null
                    ? it.descuentoPorcentaje() : BigDecimal.ZERO;
            BigDecimal factorDesc = BigDecimal.ONE.subtract(descItem.movePointLeft(2));

            PedidoShowroomItem item = PedidoShowroomItem.builder()
                    .pedido(pedido)
                    .sku(it.sku())
                    .descripcion(descripcion)
                    // Persistimos el rubro RESUELTO (rubroItem), no el crudo del
                    // request: en el flujo showroom rubroItem cae al rubro del cache
                    // cuando el request no lo trae. Sin esto, un ítem de maquinaria
                    // que llega con rubro=null se guardaba con rubro=null y, al
                    // EDITAR el pedido, resolverEsMaq lo re-derivaba como menaje →
                    // le volvía a sumar IVA y cambiaba el precio. Para pedidos de
                    // presupuesto rubroItem == it.rubro(), así que no cambia nada.
                    .rubro(rubroItem)
                    .cantidad(it.cantidad())
                    .precioUnitario(precioFinal)
                    .precioListaConIva(precioBaseConIva)
                    .porcIva(porcIva)
                    .aplicaIva(aplicaIvaItem)
                    .descuentoPorcentaje(descItem.signum() > 0 ? descItem : null)
                    .comentarios(StringUtils.hasText(it.comentarios()) ? it.comentarios().trim() : null)
                    .build();
            pedido.getItems().add(item);

            if (precioFinal != null && precioBaseConIva != null) {
                BigDecimal cant = BigDecimal.valueOf(it.cantidad());
                // Precio NETO de la línea = bruto × (1 − desc). Es lo que el
                // cliente realmente paga y lo que DUX factura (precio + porc_desc).
                BigDecimal precioFinalNeto = precioFinal.multiply(factorDesc);
                subtotalBruto = subtotalBruto.add(precioFinal.multiply(cant));
                total = total.add(precioFinalNeto.multiply(cant));
                // El descuento es del producto, no de la financiación → aplica
                // también al "sin recargo" (precio contado). Respeta el perfil de
                // IVA del ítem (maquinaria sin IVA) igual que `total`, sino el
                // montoRecargo del front mezclaría bases c/IVA y s/IVA y el recargo
                // de financiación quedaría distorsionado.
                BigDecimal baseSinRecargo = aplicaIvaItem
                        ? precioBaseConIva
                        : calcularSinIva(precioBaseConIva, porcIva);
                if (baseSinRecargo != null) {
                    totalSinRecargo = totalSinRecargo.add(baseSinRecargo.multiply(factorDesc).multiply(cant));
                }
                // totalSinIva del comprobante DUX: si la forma aplica IVA, el
                // precio_final ya tiene IVA → dividimos. Si no aplica IVA, el
                // precio_final ya es sin IVA → es directo.
                BigDecimal precioSinIvaItem = aplicaIvaItem
                        ? calcularSinIva(precioFinalNeto, porcIva)
                        : precioFinalNeto;
                if (precioSinIvaItem != null) {
                    totalSinIva = totalSinIva.add(precioSinIvaItem.multiply(cant));
                }
            }
        }
        // Re-derivar el snapshot de cabecera del perfil REALMENTE aplicado. Sin
        // esto, un pedido de maquinaria con recargo/IVA solo en el perfil
        // maquinaria mostraría en /pedidos el recargo/IVA del perfil menaje (0 o
        // el equivocado), aunque los ítems y totales se cobraron bien. Solo cuando
        // hay un único perfil en juego (pedido homogéneo); en pedidos mixtos se
        // conserva el default menaje del builder.
        if (formaPago != null) {
            if (recargosPerfilUsados.size() == 1) {
                pedido.setRecargoPorcentaje(recargosPerfilUsados.iterator().next());
            }
            if (ivasPerfilUsados.size() == 1) {
                pedido.setFormaPagoAplicaIva(ivasPerfilUsados.iterator().next());
            }
        }
        pedido.setTotal(total.setScale(2, RoundingMode.HALF_UP));
        pedido.setTotalSinIva(totalSinIva.setScale(2, RoundingMode.HALF_UP));
        // Descuento EFECTIVO del pedido = (bruto − neto) / bruto × 100. Coincide
        // con el % que muestran el carrito y el presupuesto, también con mezclas
        // de descuentos individuales. Null si no hubo descuento.
        if (subtotalBruto.signum() > 0 && subtotalBruto.compareTo(total) > 0) {
            BigDecimal descEfectivo = subtotalBruto.subtract(total)
                    .divide(subtotalBruto, 6, RoundingMode.HALF_UP)
                    .movePointRight(2)
                    .setScale(2, RoundingMode.HALF_UP);
            pedido.setDescuentoPorcentaje(descEfectivo);
        }
        // Solo persistir totalSinRecargo si efectivamente hubo recargo POSITIVO —
        // sino es ruido (el total ya es el sin-recargo). Comparamos los totales en
        // vez de mirar recargoPorc (perfil menaje): así capturamos el recargo
        // aunque venga solo del perfil maquinaria, y no guardamos ruido cuando el
        // perfil menaje tiene recargo pero el pedido es de maquinaria sin recargo.
        BigDecimal totalSinRecargoSc = totalSinRecargo.setScale(2, RoundingMode.HALF_UP);
        if (formaPago != null && pedido.getTotal().compareTo(totalSinRecargoSc) > 0) {
            pedido.setTotalSinRecargo(totalSinRecargoSc);
        }
        pedidoRepository.save(pedido);

        // Guardar/actualizar el cliente formal en el maestro (upsert por CUIT).
        // Best-effort y en su propia transacción: un fallo acá NO debe tumbar la
        // creación del pedido. Aplica también a pedidos desde presupuesto: el
        // pedido es real (con CUIT), aunque el presupuesto en sí sea informal.
        try {
            clienteMasterService.registrarDesdePedido(pedido, username);
        } catch (Exception e) {
            log.warn("No se pudo guardar el cliente formal del pedido {}: {}",
                    pedido.getId(), e.getMessage());
        }
        // Recalcular la actividad materializada del cliente tras el commit (el
        // listener AFTER_COMMIT ve el pedido y el master ya persistidos) —
        // actualiza contador, último movimiento, total e id de deep-link.
        eventPublisher.publishEvent(new ClienteMovimientoEvent(pedido.getClienteTelefonoNormalizado()));

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

                // Asociación sesión→pedido + PDF de follow-up: SOLO para el
                // flujo de showroom normal. Un pedido creado desde un presupuesto
                // (origenPresupuesto=true) no tiene sesión de atención: el
                // presupuestador no abre sesión, y consumir la sesión activa del
                // operador la cerraría mal (atención fantasma con 0 escaneados, o
                // robándole una sesión en curso de otro cliente). Además el PDF de
                // follow-up ("productos vistos no comprados") sale justamente de
                // los items escaneados en una sesión, que acá no existen.
                if (!omitirAtencion) {
                    // Finalizar la sesión de atención asociada (si la hay) y
                    // asociarla al pedido recién creado. Esto deja la sesión
                    // marcada como "completada" y permite al email service
                    // resolverla vía pedidoId al armar el PDF de follow-up.
                    sesionShowroomService.finalizarConPedido(
                            username, pedido.getId(), request.origenAtencionSesionId());

                    // Mandar el PDF de follow-up al cliente — @Async que corre en
                    // un thread distinto del pool. Si falla solo se loguea: el
                    // pedido ya está en DUX, no se revierte.
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
                }
                // Pickit externo: en el flujo showroom ya se generó al ABRIR el
                // diálogo (desde el carrito), para tenerlo listo mientras se
                // cargaban los datos del cliente — no se regenera acá. En el flujo
                // presupuesto los ítems se cargan async al abrir, así que ahí no
                // hay generación al abrir y se genera post-pedido como siempre.
                // Si la generación al abrir falló, queda el botón "regenerar
                // pickit" de la pantalla de pedidos como fallback.
                if (omitirAtencion) {
                    pickitExternoService.generarAsync(pedido, clientId);
                }

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
            // Read-timeout DESPUÉS de mandar el POST: caso AMBIGUO. DUX puede haber
            // creado el comprobante igual (no devuelve id ni acepta clave de
            // idempotencia), así que reintentar a ciegas lo DUPLICARÍA. Distinto de
            // un fallo pre-envío (connect/DNS/red), donde reintentar es seguro.
            boolean ambiguo = esTimeoutAmbiguo(e);
            // Guardamos el getMessage() crudo en BD para diagnóstico; marcamos el
            // caso ambiguo para que quede evidente en respuesta_dux (/pedidos).
            pedido.setRespuestaDux(
                    (ambiguo ? "[TIMEOUT AMBIGUO - el POST salió pero DUX no confirmó] " : "") + e.getMessage());
            pedidoRepository.save(pedido);
            String mensaje = ambiguo
                    ? "El pedido se ENVIÓ a DUX pero no llegó la confirmación (timeout). El comprobante PUEDE "
                      + "haberse creado igual. ANTES de reintentar, verificá en DUX si el pedido ya existe — "
                      + "reintentar sin verificar lo duplicaría."
                    : "Pedido guardado localmente pero falló el envío a DUX. " + UserMessages.traducir(e,
                            "No se pudo enviar el pedido a DUX. El pedido quedó guardado y puede reintentarse desde Pedidos.");
            return new CrearPedidoResponseDTO(
                    pedido.getId(),
                    EstadoPedido.ERROR,
                    null,
                    mensaje
            );
        }
    }

    /** True si la causa raíz de {@code e} es un {@link SocketTimeoutException}
     *  (read timeout). En el POST de creación de pedido significa que el request
     *  SALIÓ pero no llegó la respuesta — DUX pudo haber creado el comprobante, así
     *  que el reintento NO es seguro. Mismo criterio que los envíos de email/PDF. */
    private static boolean esTimeoutAmbiguo(Throwable e) {
        for (Throwable cur = e; cur != null; cur = cur.getCause()) {
            if (cur instanceof SocketTimeoutException) return true;
        }
        return false;
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
        // El "nombre" NO se sube a DUX (decisión del usuario jun-2026): a DUX va
        // solo la razón social como apellido_razon_social. El campo `nombre` del
        // request igual se persiste en el pedido y se guarda en la tabla de
        // clientes (columna nombre) — es dato interno, no se manda al ERP.

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
        String skuGenericoDux = duxProperties.skuProductoGenerico();
        Set<String> rubrosMaq = rubrosMaquinariaNormalizados();
        List<Map<String, Object>> productos = new ArrayList<>();
        for (CrearPedidoRequestDTO.Item it : request.items()) {
            boolean esGenerico = skuGenericoDux != null && skuGenericoDux.equals(it.sku());
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
            // Genéricos: usar el porcIva del item (lo eligió el operador).
            // Items normales: el del cache. El recargo financiero se calcula
            // sobre con-IVA, así que el porcIva solo importa cuando la forma
            // pasa a/desde s/IVA — para genéricos asumimos 21 si no vino.
            BigDecimal porcIva = esGenerico
                    ? (it.porcIva() != null ? it.porcIva() : PrecioPerfilCalculator.IVA_DEFAULT)
                    : (pc != null ? pc.getPorcIva() : null);
            // Perfil del ítem según rubro: define el recargo. A DUX siempre va
            // con IVA (se ignora el aplicaIva del perfil). Mismo criterio que
            // crearPedido: para pedidos de presupuesto NO caemos al rubro del
            // cache, usamos el del presupuesto.
            String rubroItem = request.origenPresupuesto()
                    ? it.rubro()
                    : (it.rubro() != null ? it.rubro() : (pc != null ? pc.getRubro() : null));
            boolean esMaq = resolverEsMaq(
                    request.origenPresupuesto(), it.precioReferenciaConIva(), rubroItem, rubrosMaq);
            // Precio a DUX = EXACTAMENTE el que paga el cliente según el perfil de
            // la forma ELEGIDA: parte del precio de lista (con IVA), aplica el
            // recargo/descuento de la forma y vuelve a sumar IVA SOLO si el perfil
            // del rubro lo aplica (menaje sí, maquinaria en formas s/IVA no). Es la
            // MISMA fórmula que `precioFinal` en crearPedido, así DUX factura lo que
            // paga el cliente (ya no se "absorbe" IVA en las líneas s/IVA). Para
            // pedidos de presupuesto, `precioBaseConIva` es el PVP CONGELADO del
            // presupuesto (it.precioUnitario), así respeta lo cotizado reflejando la
            // forma elegida — coincide con el preview del diálogo.
            boolean aplicaIvaItem = aplicaIvaPerfil(formaPago, esMaq);
            BigDecimal precioDux = formaPago != null
                    ? calcularPrecioFinal(precioBaseConIva, porcIva, recargoPerfil(formaPago, esMaq), aplicaIvaItem)
                    : precioBaseConIva;
            d.put("precio", precioDux != null ? precioDux : BigDecimal.ZERO);
            d.put("porc_desc", it.descuentoPorcentaje() != null ? it.descuentoPorcentaje() : BigDecimal.ZERO);
            if (StringUtils.hasText(it.comentarios())) {
                d.put("comentarios", it.comentarios().trim());
            }
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
        String low = mensaje.toLowerCase(Locale.ROOT);
        // Guarda anti-falso-positivo: un mensaje que NIEGA o reporta error NO es
        // éxito aunque contenga la palabra "éxito" (ej. "no se pudo ingresar con
        // éxito", "sin éxito"). Se chequea antes del match positivo. Si DUX cambia
        // el wording, es preferible un falso ERROR (el operador reintenta) a un
        // falso ENVIADO (cierra la sesión y manda follow-up de un pedido rechazado).
        if (low.contains("no se pudo") || low.contains("no fue") || low.contains("sin éxito")
                || low.contains("sin exito") || low.contains("error") || low.contains("debe ")
                || low.contains("fall")) {
            return false;
        }
        return low.contains("exito") || low.contains("éxito") || low.contains("ingresado con");
    }

    // =====================================================
    // Helpers de cálculo de precio por perfil — delegan a PrecioPerfilCalculator
    // (bean compartido). Se duplican acá como privados porque ShowroomService
    // conserva los suyos para el scan/catálogo; no hay lógica nueva.
    // =====================================================

    private BigDecimal calcularSinIva(BigDecimal conIva, BigDecimal porcIva) {
        return PrecioPerfilCalculator.calcularSinIva(conIva, porcIva);
    }

    private BigDecimal calcularPrecioFinal(BigDecimal precioBaseConIva, BigDecimal porcIva,
                                           BigDecimal recargoPorc, boolean aplicaIva) {
        return PrecioPerfilCalculator.calcularPrecioFinal(precioBaseConIva, porcIva, recargoPorc, aplicaIva);
    }

    /** Normaliza un rubro para comparación robusta (trim, sin acentos, mayúsculas). */
    private static String normalizarRubro(String rubro) {
        return PrecioPerfilCalculator.normalizarRubro(rubro);
    }

    /** Perfil (maquinaria/menaje) del ítem. En pedidos de presupuesto que traen
     *  el snapshot {@code precioReferenciaConIva}, CONGELA el perfil con que se
     *  cotizó ({@code esMaq = !precioReferenciaConIva}), para no re-derivarlo por
     *  rubro si la lista de rubros sin IVA cambió entre cotizar y convertir. En
     *  el showroom normal, o si el presupuesto es viejo (flag null), deriva por
     *  rubro como hasta ahora. */
    static boolean resolverEsMaq(boolean origenPresupuesto, Boolean precioReferenciaConIva,
                                 String rubroItem, Set<String> rubrosMaq) {
        if (origenPresupuesto && precioReferenciaConIva != null) {
            return !precioReferenciaConIva;
        }
        return !rubrosMaq.isEmpty() && rubrosMaq.contains(normalizarRubro(rubroItem));
    }

    /** Set normalizado de rubros de maquinaria (configurables; misma lista que
     *  "rubros que cotizan sin IVA"). */
    private Set<String> rubrosMaquinariaNormalizados() {
        return precioPerfilCalculator.rubrosMaquinariaNormalizados();
    }

    /** Recargo del perfil del rubro. Maquinaria: su propio recargo (null → 0, NO
     *  hereda del normal). Normal: recargoPorcentaje (null → 0). */
    private static BigDecimal recargoPerfil(FormaPago fp, boolean esMaquinaria) {
        return PrecioPerfilCalculator.recargoPerfil(fp, esMaquinaria);
    }

    /** aplicaIva del perfil: maquinaria null→false; normal null→true. */
    private static boolean aplicaIvaPerfil(FormaPago fp, boolean esMaquinaria) {
        return PrecioPerfilCalculator.aplicaIvaPerfil(fp, esMaquinaria);
    }
}
