package ar.com.leo.showroom.presupuesto.service;

import ar.com.leo.showroom.auth.repository.UsuarioRepository;
import ar.com.leo.showroom.auth.service.UsuarioService;
import ar.com.leo.showroom.catalogo.entity.Localidad;
import ar.com.leo.showroom.catalogo.entity.Provincia;
import ar.com.leo.showroom.catalogo.repository.LocalidadRepository;
import ar.com.leo.showroom.catalogo.repository.ProvinciaRepository;
import ar.com.leo.showroom.catalogo.service.ImagenLocalService;
import ar.com.leo.showroom.cliente.entity.ClienteMaster;
import ar.com.leo.showroom.cliente.event.ClienteMovimientoEvent;
import ar.com.leo.showroom.cliente.service.ClienteMasterService;
import ar.com.leo.showroom.common.exception.ConflictException;
import ar.com.leo.showroom.common.exception.NotFoundException;
import ar.com.leo.showroom.common.exception.UserMessages;
import ar.com.leo.showroom.common.util.SortUtils;
import ar.com.leo.showroom.common.util.TextUtils;
import ar.com.leo.showroom.config.service.PrecioPerfilCalculator;
import ar.com.leo.showroom.events.SyncEventService;
import ar.com.leo.showroom.pedido.entity.EstadoPedido;
import ar.com.leo.showroom.pedido.repository.PedidoShowroomRepository;
import ar.com.leo.showroom.presupuesto.dto.ClientePresupuestosDTO;
import ar.com.leo.showroom.presupuesto.dto.ClientesPageDTO;
import ar.com.leo.showroom.presupuesto.dto.GenerarPresupuestoRequestDTO;
import ar.com.leo.showroom.presupuesto.dto.PresupuestoDetalleDTO;
import ar.com.leo.showroom.presupuesto.dto.PresupuestoListItemDTO;
import ar.com.leo.showroom.presupuesto.dto.PresupuestoListPageDTO;
import ar.com.leo.showroom.presupuesto.entity.PresupuestoComercial;
import ar.com.leo.showroom.presupuesto.repository.PresupuestoComercialRepository;
import ar.com.leo.showroom.showroom.dto.CrearPedidoRequestDTO;
import ar.com.leo.showroom.showroom.dto.CrearPedidoResponseDTO;
import ar.com.leo.showroom.pedido.service.PedidoService;
import jakarta.mail.internet.MimeMessage;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Lazy;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.mail.javamail.MimeMessageHelper;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;
import tools.jackson.databind.ObjectMapper;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.net.SocketTimeoutException;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * Orquesta el ciclo de vida del presupuesto comercial: calcula totales,
 * persiste la cabecera solo cuando se envía al cliente (preview es transitorio
 * para no quemar números) y dispara el envío del email en background.
 *
 * <p>NO se manda nada a DUX — el presupuesto es 100% local y sirve como
 * pieza comercial previa al pedido.
 */
@Slf4j
@Service
public class PresupuestoComercialService {

    private static final String SSE_EVENT = "presupuesto-comercial-email";
    private static final String SUBJECT = "KT GASTRO — Presupuesto #";

    private final PresupuestoComercialRepository repository;
    private final PresupuestoComercialPdfGenerator pdfGenerator;
    private final JavaMailSender mailSender;
    private final SyncEventService eventService;
    private final ObjectMapper mapper;
    private final UsuarioRepository usuarioRepository;
    /** Lookup bulk de operadores (usuarioId → displayName) compartido por todos
     *  los listados. */
    private final UsuarioService usuarioService;
    /** Para unificar la vista de clientes con los pedidos (no solo
     *  presupuestos). El service lee pedidos directamente del repo y los
     *  agrupa junto con los presupuestos por teléfono normalizado. */
    private final PedidoShowroomRepository pedidoRepository;
    /** Maestro editable de clientes — se mergea con los datos derivados del
     *  historial al armar la vista de /clientes (nombre/email/rubro del master
     *  pisan los del último movimiento). */
    private final ClienteMasterService clienteMasterService;
    /** Fórmula de precios por perfil (menaje/maquinaria), compartida con el
     *  showroom para que el presupuesto calcule las formas igual que el carrito. */
    private final PrecioPerfilCalculator precioPerfilCalculator;
    /** Para resolver los nombres de provincia/localidad de envío (los pedidos
     *  guardan solo los códigos) al armar la vista de /clientes. */
    private final ProvinciaRepository provinciaRepository;
    private final LocalidadRepository localidadRepository;
    /** Resuelve la URL de la miniatura por SKU al armar el detalle del
     *  historial — mismo patrón centralizado que usa {@code PedidoService}. */
    private final ImagenLocalService imagenLocalService;
    /** Publica {@link ClienteMovimientoEvent} para recalcular la actividad del
     *  cliente en fase AFTER_COMMIT (ver {@code ClienteMasterService}). */
    private final org.springframework.context.ApplicationEventPublisher eventPublisher;

    /**
     * Self-injection para que {@link #enviarPorEmailAsync} (anotado {@code @Async})
     * pase por el proxy de Spring cuando se invoca desde {@link #generarYEnviarPorEmail}.
     * Sin esto, la llamada {@code this.enviarPorEmailAsync(...)} es self-invocation
     * y el aspect de async se ignora — el envío corre sincrónicamente bloqueando
     * el thread HTTP del controller. Mismo patrón que {@code CatalogoSyncService.self}.
     */
    @Autowired
    @Lazy
    private PresupuestoComercialService self;

    /**
     * Para regenerar el pedido de un presupuesto editado: reusa la creación
     * (alta + envío a DUX) y la anulación local de {@link PedidoService}.
     * {@code @Lazy} para no introducir un ciclo en el arranque — PedidoService
     * depende del REPO de presupuestos, no de este service.
     */
    @Autowired
    @Lazy
    private PedidoService pedidoService;

    @Value("${showroom.picking.email-enabled:false}")
    private boolean emailEnabled;

    @Value("${showroom.picking.email-from:}")
    private String emailFrom;

    @Value("${spring.mail.username:}")
    private String mailUsername;

    public PresupuestoComercialService(
            PresupuestoComercialRepository repository,
            PresupuestoComercialPdfGenerator pdfGenerator,
            ObjectProvider<JavaMailSender> mailSender,
            SyncEventService eventService,
            ObjectMapper mapper,
            UsuarioRepository usuarioRepository,
            UsuarioService usuarioService,
            PedidoShowroomRepository pedidoRepository,
            ClienteMasterService clienteMasterService,
            PrecioPerfilCalculator precioPerfilCalculator,
            ProvinciaRepository provinciaRepository,
            LocalidadRepository localidadRepository,
            ImagenLocalService imagenLocalService,
            org.springframework.context.ApplicationEventPublisher eventPublisher) {
        this.repository = repository;
        this.pdfGenerator = pdfGenerator;
        this.mailSender = mailSender.getIfAvailable();
        this.eventService = eventService;
        this.mapper = mapper;
        this.usuarioRepository = usuarioRepository;
        this.usuarioService = usuarioService;
        this.pedidoRepository = pedidoRepository;
        this.clienteMasterService = clienteMasterService;
        this.precioPerfilCalculator = precioPerfilCalculator;
        this.provinciaRepository = provinciaRepository;
        this.localidadRepository = localidadRepository;
        this.imagenLocalService = imagenLocalService;
        this.eventPublisher = eventPublisher;
    }

    /** Resuelve username a usuarioId. Null si el username no existe (caso
     *  teórico — el controller siempre manda un username autenticado). */
    private Long usuarioIdDe(String username) {
        if (username == null) return null;
        return usuarioRepository.findByUsername(username).map(u -> u.getId()).orElse(null);
    }

    /** Resuelve usuarioId a username para publicar el SSE en su canal. Null
     *  si el id no resuelve (legacy data) — el caller usa fallback global. */
    private String usernameDe(Long usuarioId) {
        if (usuarioId == null) return null;
        return usuarioRepository.findById(usuarioId).map(u -> u.getUsername()).orElse(null);
    }

    private void publicarEvento(String operador, Object payload) {
        if (operador != null) {
            eventService.publishTo(operador, SSE_EVENT, payload);
        } else {
            eventService.publish(SSE_EVENT, payload);
        }
    }

    /**
     * Persiste el presupuesto (asigna número), genera el PDF y devuelve el
     * resultado SIN enviar email. Usado por el botón "Descargar PDF" del
     * frontend para que el operador pueda mandar el archivo manualmente al
     * cliente (WhatsApp/email/etc.) con un número definitivo.
     *
     * <p>Cada llamada genera UN número nuevo en BD. Si el operador toca el
     * botón varias veces se gastan números — trade-off aceptado a cambio de
     * tener PDFs listos para enviar sin paso intermedio.
     */
    @Transactional
    public Resultado generarYPersistir(GenerarPresupuestoRequestDTO datos, String username) {
        PresupuestoComercial p = construirEntidad(datos);
        p.setUsuarioId(usuarioIdDe(username));
        p = repository.save(p);
        registrarClienteMaster(p, username);
        byte[] pdf = pdfGenerator.generar(p, datos);
        return new Resultado(p, pdf, pdfGenerator.nombreArchivo(p));
    }

    /** Ensure/actualiza el cliente del presupuesto en el maestro (fuente de la
     *  vista /clientes). Best-effort: un fallo acá no debe tumbar el presupuesto. */
    private void registrarClienteMaster(PresupuestoComercial p, String username) {
        try {
            clienteMasterService.registrarDesdePresupuesto(
                    p.getClienteTelefono(), p.getClienteNombre(),
                    p.getClienteEmail(), p.getRubro(), username);
        } catch (Exception e) {
            log.warn("No se pudo registrar el cliente del presupuesto {}: {}",
                    p.getId(), e.getMessage());
        }
        // Recalcular la actividad materializada del cliente tras el commit (el
        // listener AFTER_COMMIT ve el presupuesto y el master ya persistidos).
        eventPublisher.publishEvent(new ClienteMovimientoEvent(p.getClienteTelefonoNormalizado()));
    }

    /**
     * Crea el presupuesto en BD (asigna número), genera el PDF y dispara el
     * envío del email en background. Devuelve el {@link Resultado} con el ID
     * generado para que el controller lo informe al frontend; el resultado
     * real del envío llega vía SSE {@code presupuesto-comercial-email}
     * <b>solo en la pantalla del operador {@code username}</b>.
     */
    @Transactional
    public Resultado generarYEnviarPorEmail(String destinatario,
                                            GenerarPresupuestoRequestDTO datos,
                                            String username) {
        Resultado r = generarYPersistir(datos, username);
        // self.* atraviesa el proxy de Spring para que @Async funcione.
        self.enviarPorEmailAsync(destinatario, r.presupuesto().getId(),
                r.presupuesto().getClienteNombre(), r.pdf(), r.nombreArchivo(),
                username);
        return r;
    }

    /**
     * Actualiza in-place un presupuesto existente: pisa todos los campos
     * (cliente, items, formas, descuento, observaciones) con el nuevo payload,
     * setea {@code modificadoAt = now()} y regenera el PDF con los nuevos datos.
     *
     * <p>Conserva el id y {@code creadoAt} originales — el número de presupuesto
     * y el slot del historial NO cambian. El operador que editó queda como
     * {@code modificadoPor} en el SSE pero la entity sigue atribuida al creador
     * original ({@code usuarioId}).
     */
    @Transactional
    public Resultado actualizar(Long id, GenerarPresupuestoRequestDTO datos, String username) {
        PresupuestoComercial p = obtener(id);
        // Teléfono ANTES de pisar los datos: si el operador lo cambió al editar,
        // el cliente anterior perdió este presupuesto y hay que recalcular su
        // actividad también (sino le queda el contador inflado / un "último
        // presupuesto" que ya no es suyo).
        String telNormAnterior = p.getClienteTelefonoNormalizado();
        aplicarDatos(p, datos);
        p.setModificadoAt(Instant.now());
        p = repository.save(p);
        registrarClienteMaster(p, username);
        String telNormNuevo = p.getClienteTelefonoNormalizado();
        if (telNormAnterior != null && !telNormAnterior.equals(telNormNuevo)) {
            eventPublisher.publishEvent(new ClienteMovimientoEvent(telNormAnterior));
        }
        byte[] pdf = pdfGenerator.generar(p, datos);
        return new Resultado(p, pdf, pdfGenerator.nombreArchivo(p));
    }

    /**
     * Versión de {@link #actualizar} que además dispara el envío del PDF por
     * email en background. Mismo patrón que
     * {@link #generarYEnviarPorEmail} pero sobre un presupuesto existente —
     * el id NO cambia.
     */
    @Transactional
    public Resultado actualizarYEnviarPorEmail(Long id, String destinatario,
                                               GenerarPresupuestoRequestDTO datos,
                                               String username) {
        Resultado r = actualizar(id, datos, username);
        self.enviarPorEmailAsync(destinatario, r.presupuesto().getId(),
                r.presupuesto().getClienteNombre(), r.pdf(), r.nombreArchivo(),
                username);
        return r;
    }

    /**
     * Snapshot completo del presupuesto persistido — usado por el frontend
     * para pre-llenar la pantalla de edición. Reusa el {@link #rehidratarDatos}
     * que ya sabe deserializar los JSONs y inferir el modo {@code
     * cotizacionIndividual}.
     */
    public PresupuestoDetalleDTO obtenerDetalle(Long id) {
        PresupuestoComercial p = obtener(id);
        GenerarPresupuestoRequestDTO datos = rehidratarDatos(p);
        return new PresupuestoDetalleDTO(
                p.getId(),
                p.getCreadoAt(),
                p.getModificadoAt(),
                p.getClienteNombre(),
                p.getClienteTelefono(),
                p.getClienteEmail(),
                p.getRubro(),
                p.getObservaciones(),
                p.getDescuentoGlobalPorcentaje(),
                datos.cotizacionIndividual(),
                p.getConvertidoEnPedidoId(),
                p.getConvertidoAt(),
                conImagenUrl(datos.items()),
                datos.formasPago(),
                p.getFormaPagoSeleccionadaId());
    }

    /** Rehidrata cada ítem con la URL de su miniatura resuelta por SKU (null si
     *  no hay archivo), para que el historial muestre la imagen igual que
     *  pedidos/atención. La URL no se persiste: se recalcula en cada lectura. */
    private List<GenerarPresupuestoRequestDTO.Item> conImagenUrl(List<GenerarPresupuestoRequestDTO.Item> items) {
        if (items == null) return List.of();
        return items.stream()
                .map(it -> withImagenUrl(it, imagenLocalService.urlPublica(it.sku())))
                .toList();
    }

    /** Devuelve los ítems con {@code imagenUrl} en null — usado antes de
     *  persistir para no hornear la URL derivada en el JSON. */
    private List<GenerarPresupuestoRequestDTO.Item> sinImagenUrl(List<GenerarPresupuestoRequestDTO.Item> items) {
        if (items == null) return List.of();
        return items.stream().map(it -> withImagenUrl(it, null)).toList();
    }

    /** Copia el ítem cambiando solo {@code imagenUrl}. */
    private GenerarPresupuestoRequestDTO.Item withImagenUrl(GenerarPresupuestoRequestDTO.Item it, String imagenUrl) {
        return new GenerarPresupuestoRequestDTO.Item(
                it.sku(),
                it.descripcion(),
                it.rubro(),
                it.cantidad(),
                it.precioConIva(),
                it.porcIva(),
                it.descuentoPorcentaje(),
                it.comentarios(),
                it.precioReferencia(),
                it.precioReferenciaConIva(),
                imagenUrl);
    }

    public PresupuestoComercial obtener(Long id) {
        PresupuestoComercial p = repository.findById(id)
                .orElseThrow(() -> new NotFoundException("Presupuesto comercial no encontrado: " + id));
        if (p.getEliminadoAt() != null) {
            throw new NotFoundException("Presupuesto comercial eliminado: " + id);
        }
        return p;
    }

    /**
     * Soft-delete del presupuesto: setea {@code eliminado_at = now()}. El
     * registro físicamente persiste pero deja de aparecer en el historial.
     * Si el operador borra por error, se puede restaurar manualmente desde
     * la DB con {@code UPDATE presupuesto_comercial SET eliminado_at = NULL
     * WHERE id = ?}. No-op si ya estaba eliminado.
     */
    @Transactional
    public void eliminar(Long id) {
        PresupuestoComercial p = repository.findById(id)
                .orElseThrow(() -> new NotFoundException("Presupuesto comercial no encontrado: " + id));
        if (p.getEliminadoAt() != null) return;
        p.setEliminadoAt(Instant.now());
        repository.save(p);
        // Al borrar un presupuesto baja el contador y puede cambiar el último
        // movimiento del cliente — recalculamos su actividad tras el commit.
        eventPublisher.publishEvent(new ClienteMovimientoEvent(p.getClienteTelefonoNormalizado()));
    }

    /**
     * Whitelist de campos por los que se permite ordenar el listado de
     * presupuestos. Mapea el nombre que manda el frontend (id de columna del
     * p-table) al nombre del atributo en la entity. Evita "SQL injection via
     * sort field" al pasar el parámetro directo al ORDER BY. La columna "Total"
     * del listado se llama {@code totalSinIva} en el DTO pero corresponde al
     * atributo {@code subtotalSinIva} de la entity.
     */
    private static final Map<String, String> SORT_PRESUPUESTOS = Map.of(
            "id", "id",
            "creadoAt", "creadoAt",
            "clienteNombre", "clienteNombre",
            "clienteEmail", "clienteEmail",
            "clienteTelefono", "clienteTelefono",
            "rubro", "rubro",
            // La columna "Operador" usa `creadoPor` en el DTO; ordena por el
            // campo directo `usuarioId` de la entity (agrupa por operador).
            "creadoPor", "usuarioId",
            "totalSinIva", "subtotalSinIva",
            "descuentoGlobalPorcentaje", "descuentoGlobalPorcentaje");

    /**
     * Lista paginada para la pantalla de historial. Soporta filtros por
     * texto libre (nombre/email/teléfono), rango de fechas e id puntual
     * (deep-link). Orden default: más recientes primero.
     */
    public PresupuestoListPageDTO listar(Long id, String q, Instant desde, Instant hasta,
                                         int page, int size, String sortField, String sortOrder) {
        String qNormalizada = (q == null || q.isBlank()) ? null : q.trim();
        // Resolver el sort: si el campo no está en la whitelist o no se pidió,
        // usar `creadoAt desc` (default histórico de la pantalla).
        Sort sort = SortUtils.resolver(SORT_PRESUPUESTOS, sortField, sortOrder, "creadoAt");
        PageRequest pr = PageRequest.of(page, size, sort);
        org.springframework.data.domain.Page<PresupuestoComercial> p =
                repository.buscar(id, qNormalizada, desde, hasta, pr);
        // Bulk lookup de operadores para la página — una sola query a usuario.
        java.util.Set<Long> usuarioIds = p.getContent().stream()
                .map(PresupuestoComercial::getUsuarioId)
                .filter(java.util.Objects::nonNull)
                .collect(java.util.stream.Collectors.toSet());
        Map<Long, String> operadores = usuarioService.nombresPorId(usuarioIds);
        List<PresupuestoListItemDTO> items = p.getContent().stream()
                .map(pc -> toListItemDTO(pc,
                        pc.getUsuarioId() == null ? null : operadores.get(pc.getUsuarioId())))
                .toList();
        return new PresupuestoListPageDTO(items, p.getTotalElements(), p.getNumber(), p.getSize());
    }

    /**
     * Página de clientes para la vista /clientes, derivada del maestro
     * ({@link ClienteMaster}) que es la fuente única de la lista. La actividad
     * (contadores, último movimiento/total, ids de deep-link) está materializada
     * en el master y se mantiene al día en cada movimiento
     * ({@code ClienteMasterService.recalcularActividad}), así que esto es un
     * SELECT paginado directo: soporta buscar por texto y ORDENAR por cualquier
     * columna sin cruzar presupuestos+pedidos en memoria. El backfill inicial de
     * los clientes legacy lo hace {@code ClienteActividadBackfillService} al
     * arrancar la aplicación.
     */
    private static final Map<String, String> SORT_CLIENTES = Map.ofEntries(
            Map.entry("nombre", "nombre"),
            Map.entry("razonSocial", "razonSocial"),
            Map.entry("email", "email"),
            // La columna "Teléfono" muestra el normalizado (es lo que guarda el master).
            Map.entry("telefono", "telefonoNormalizado"),
            Map.entry("rubro", "rubro"),
            Map.entry("nroDoc", "nroDoc"),
            Map.entry("domicilio", "domicilio"),
            Map.entry("cantidadPresupuestos", "cantidadPresupuestos"),
            Map.entry("cantidadPedidos", "cantidadPedidos"),
            Map.entry("ultimoMovimientoAt", "ultimoMovimientoAt"));

    @Transactional(readOnly = true)
    public ClientesPageDTO listarClientes(String q, int page, int size,
                                          String sortField, String sortOrder) {
        // Default: cliente más reciente arriba. MySQL pone los NULL (alta manual
        // sin movimientos) al final en DESC, igual que el comportamiento previo.
        // Desempate por id: sin él, cuando muchos clientes comparten el valor de
        // orden (p. ej. ultimoMovimientoAt NULL, o cantidadPedidos 0) MySQL no
        // garantiza orden estable entre páginas → filas repetidas/salteadas.
        Sort sort = SortUtils.resolver(SORT_CLIENTES, sortField, sortOrder, "ultimoMovimientoAt")
                .and(Sort.by(Sort.Direction.ASC, "id"));
        PageRequest pr = PageRequest.of(page, size, sort);
        org.springframework.data.domain.Page<ClienteMaster> pagina =
                clienteMasterService.buscarClientes(q, pr);
        List<ClientePresupuestosDTO> items = mapearConUbicacion(pagina.getContent());
        return new ClientesPageDTO(items, pagina.getTotalElements(), pagina.getNumber(), pagina.getSize());
    }

    /**
     * Todos los clientes (no eliminados) que matchean {@code q}, sin paginar —
     * para el export CSV, que necesita el conjunto completo y no solo la página
     * visible. Ordena por última actividad descendente (default del listado).
     */
    @Transactional(readOnly = true)
    public List<ClientePresupuestosDTO> listarClientesParaExport(String q) {
        // Página única amplia: el export es puntual y el universo de clientes es
        // acotado. Mismo orden por defecto que el listado.
        PageRequest pr = PageRequest.of(0, 100_000,
                Sort.by(Sort.Direction.DESC, "ultimoMovimientoAt").and(Sort.by(Sort.Direction.ASC, "id")));
        return mapearConUbicacion(clienteMasterService.buscarClientes(q, pr).getContent());
    }

    /** Mapea masters a DTO resolviendo provincia/localidad en batch (evita N+1):
     *  una lectura de provincias (pocas) y un findAllById de las localidades de
     *  la página. */
    private List<ClientePresupuestosDTO> mapearConUbicacion(List<ClienteMaster> masters) {
        Map<String, String> provinciaPorCodIso = provinciaRepository.findAll().stream()
                .filter(p -> p.getCodIso() != null && p.getNombre() != null)
                .collect(Collectors.toMap(
                        p -> p.getCodIso().toLowerCase(),
                        Provincia::getNombre,
                        (a, b) -> a));
        Set<Long> idsLocalidad = masters.stream()
                .map(ClienteMaster::getIdLocalidad)
                .map(PresupuestoComercialService::parseLongOrNull)
                .filter(Objects::nonNull)
                .collect(Collectors.toSet());
        Map<Long, String> localidadPorId = idsLocalidad.isEmpty()
                ? Map.of()
                : localidadRepository.findAllById(idsLocalidad).stream()
                        .collect(Collectors.toMap(
                                Localidad::getId,
                                Localidad::getNombre,
                                (a, b) -> a));
        return masters.stream()
                .map(m -> resolverUbicacion(dtoDesdeMaster(m), provinciaPorCodIso, localidadPorId))
                .toList();
    }

    /**
     * Arma el DTO de /clientes con los datos + la actividad materializada del
     * MASTER. La actividad la mantiene al día
     * {@code ClienteMasterService.recalcularActividad} en cada movimiento; acá
     * solo se lee. provinciaNombre/localidadNombre se resuelven aparte en
     * {@link #resolverUbicacion}.
     */
    private ClientePresupuestosDTO dtoDesdeMaster(ClienteMaster m) {
        return new ClientePresupuestosDTO(
                m.getEmail(),
                m.getTelefonoNormalizado(),
                m.getNombre(),
                m.getRubro(),
                m.getCantidadPresupuestos(),
                m.getCantidadPedidos(),
                m.getPrimerMovimientoAt(),
                m.getUltimoMovimientoAt(),
                m.getUltimoPresupuestoId(),
                m.getUltimoPedidoId(),
                m.getTipoDoc(),
                m.getNroDoc(),
                m.getDomicilio(),
                m.getCodigoProvincia(),
                null,
                m.getIdLocalidad(),
                null,
                m.getRazonSocial(),
                m.getNotas());
    }

    /** Completa {@code provinciaNombre}/{@code localidadNombre} resolviendo los
     *  códigos contra los mapas precargados (provincias por cod_iso, localidades
     *  por id). Se aplica DESPUÉS del merge con el master, así si el operador
     *  editó la provincia/localidad en el maestro se muestra el nombre correcto. */
    private static ClientePresupuestosDTO resolverUbicacion(
            ClientePresupuestosDTO dto,
            Map<String, String> provinciaPorCodIso,
            Map<Long, String> localidadPorId) {
        String provNombre = dto.codigoProvincia() != null
                ? provinciaPorCodIso.get(dto.codigoProvincia().toLowerCase())
                : null;
        Long locId = parseLongOrNull(dto.idLocalidad());
        String locNombre = locId != null ? localidadPorId.get(locId) : null;
        if (provNombre == null && locNombre == null) return dto;
        return new ClientePresupuestosDTO(
                dto.email(), dto.telefono(), dto.nombre(), dto.rubro(),
                dto.cantidadPresupuestos(), dto.cantidadPedidos(),
                dto.primerMovimientoAt(), dto.ultimoMovimientoAt(),
                dto.ultimoPresupuestoId(), dto.ultimoPedidoId(),
                dto.tipoDoc(), dto.nroDoc(), dto.domicilio(),
                dto.codigoProvincia(), provNombre,
                dto.idLocalidad(), locNombre, dto.razonSocial(), dto.notas());
    }

    private static Long parseLongOrNull(String s) {
        if (s == null || s.isBlank()) return null;
        try {
            return Long.parseLong(s.trim());
        } catch (NumberFormatException e) {
            return null;
        }
    }

    /**
     * Regenera el PDF de un presupuesto persistido con el modo original
     * (inferido de las formas guardadas).
     */
    public Resultado regenerarPdf(Long id) {
        return regenerarPdf(id, null);
    }

    /**
     * Regenera el PDF de un presupuesto persistido, pudiendo FORZAR el modo
     * de cotización (agregado o individual). Útil para que el operador pueda
     * descargar AMBAS versiones del mismo presupuesto desde el historial,
     * independientemente de cómo se generó originalmente.
     *
     * <p>Cuando el modo forzado difiere del original, recalculamos las
     * formas de pago sobre los datos persistidos:
     * <ul>
     *   <li>Forzar AGREGADO sobre individual: deduplicamos formas por
     *       nombre y recalculamos {@code precioFinal} sobre el subtotal
     *       general.</li>
     *   <li>Forzar INDIVIDUAL sobre agregado: deduplicamos formas por
     *       nombre y replicamos por cada ítem, recalculando
     *       {@code precioFinal} sobre el precio del ítem.</li>
     * </ul>
     *
     * @param modo {@code "agregado"} / {@code "individual"} / null (= original).
     */
    public Resultado regenerarPdf(Long id, String modo) {
        PresupuestoComercial p = obtener(id);
        GenerarPresupuestoRequestDTO datos = rehidratarDatos(p);
        if ("agregado".equalsIgnoreCase(modo) && Boolean.TRUE.equals(datos.cotizacionIndividual())) {
            datos = forzarModoAgregado(datos);
        } else if ("individual".equalsIgnoreCase(modo) && !Boolean.TRUE.equals(datos.cotizacionIndividual())) {
            datos = forzarModoIndividual(datos);
        }
        byte[] pdf = pdfGenerator.generar(p, datos);
        return new Resultado(p, pdf, pdfGenerator.nombreArchivo(p));
    }

    /** Convierte un DTO en modo individual al modo agregado: deduplica las
     *  formas (todas las que comparten {@code id}/{@code nombre}/{@code
     *  cantidadCuotas} son la misma) y recalcula {@code precioFinal} sobre
     *  el subtotal del presupuesto. Limpia {@code itemSku} a null. */
    private GenerarPresupuestoRequestDTO forzarModoAgregado(GenerarPresupuestoRequestDTO datos) {
        java.util.Set<String> rubrosMaq = precioPerfilCalculator.rubrosMaquinariaNormalizados();
        List<GenerarPresupuestoRequestDTO.FormaPagoSnapshot> formasUnicas =
                deduplicarFormas(datos.formasPago());
        List<GenerarPresupuestoRequestDTO.FormaPagoSnapshot> formasAgregadas = new java.util.ArrayList<>();
        for (GenerarPresupuestoRequestDTO.FormaPagoSnapshot f : formasUnicas) {
            // El precio de la forma es la suma por ítem usando el perfil
            // (menaje/maquinaria) del rubro de cada ítem — coincide con el
            // carrito del showroom para presupuestos mixtos.
            BigDecimal precioFinal = BigDecimal.ZERO;
            for (GenerarPresupuestoRequestDTO.Item it : datos.items()) {
                boolean esMaq = PrecioPerfilCalculator.esMaquinaria(it.rubro(), rubrosMaq);
                precioFinal = precioFinal.add(precioFormaPerfil(f, esMaq, it));
            }
            precioFinal = precioFinal.setScale(2, RoundingMode.HALF_UP);
            formasAgregadas.add(new GenerarPresupuestoRequestDTO.FormaPagoSnapshot(
                    f.id(), f.nombre(), f.recargoPorcentaje(), f.cantidadCuotas(),
                    f.aplicaIva(), precioFinal, f.descripcion(), f.monedaSimbolo(),
                    null, f.recargoPorcentajeMaquinaria(), f.aplicaIvaMaquinaria()));
        }
        return new GenerarPresupuestoRequestDTO(
                datos.clienteNombre(), datos.clienteTelefono(), datos.clienteEmail(),
                datos.rubro(), datos.observaciones(), datos.descuentoGlobalPorcentaje(),
                false, datos.formaPagoSeleccionadaId(), datos.origenAtencionSesionId(), datos.items(), formasAgregadas);
    }

    /** Total con IVA de una línea: precio con IVA × (1 − desc%) × cantidad. */
    private static BigDecimal totalLineaConIva(GenerarPresupuestoRequestDTO.Item it) {
        BigDecimal cantidad = it.cantidad() == null ? BigDecimal.ZERO : it.cantidad();
        BigDecimal precio = it.precioConIva() == null ? BigDecimal.ZERO : it.precioConIva();
        BigDecimal d = it.descuentoPorcentaje() == null ? BigDecimal.ZERO : it.descuentoPorcentaje();
        BigDecimal factor = BigDecimal.ONE.subtract(d.movePointLeft(2));
        return precio.multiply(factor).multiply(cantidad);
    }

    /** Precio que paga el cliente por un total de línea (con IVA) con una forma,
     *  según el perfil (menaje/maquinaria) que corresponde al rubro. Usa el
     *  calculador compartido para coincidir exactamente con el showroom: recargo
     *  &gt;0 financia (÷(1−r)), recargo &lt;0 descuenta (×(1+r)), e IVA según perfil. */
    private static BigDecimal precioFormaPerfil(
            GenerarPresupuestoRequestDTO.FormaPagoSnapshot f, boolean esMaq,
            GenerarPresupuestoRequestDTO.Item it) {
        BigDecimal porcIva = it.porcIva() == null ? PrecioPerfilCalculator.IVA_DEFAULT : it.porcIva();
        BigDecimal pf = PrecioPerfilCalculator.calcularPrecioFinal(
                totalLineaConIva(it), porcIva, f.recargoPerfil(esMaq), f.aplicaIvaPerfil(esMaq));
        return pf != null ? pf : BigDecimal.ZERO;
    }

    /** Convierte un DTO en modo agregado al modo individual: deduplica las
     *  formas y, para cada ítem, calcula su propio {@code precioFinal} por
     *  forma sobre el precio del ítem (cantidad × precio × (1-desc)). */
    private GenerarPresupuestoRequestDTO forzarModoIndividual(GenerarPresupuestoRequestDTO datos) {
        java.util.Set<String> rubrosMaq = precioPerfilCalculator.rubrosMaquinariaNormalizados();
        List<GenerarPresupuestoRequestDTO.FormaPagoSnapshot> formasUnicas =
                deduplicarFormas(datos.formasPago());
        List<GenerarPresupuestoRequestDTO.FormaPagoSnapshot> formasIndividuales = new java.util.ArrayList<>();
        for (GenerarPresupuestoRequestDTO.Item it : datos.items()) {
            boolean esMaq = PrecioPerfilCalculator.esMaquinaria(it.rubro(), rubrosMaq);
            for (GenerarPresupuestoRequestDTO.FormaPagoSnapshot f : formasUnicas) {
                BigDecimal precioFinal = precioFormaPerfil(f, esMaq, it).setScale(2, RoundingMode.HALF_UP);
                formasIndividuales.add(new GenerarPresupuestoRequestDTO.FormaPagoSnapshot(
                        f.id(), f.nombre(), f.recargoPorcentaje(), f.cantidadCuotas(),
                        f.aplicaIva(), precioFinal, f.descripcion(), f.monedaSimbolo(),
                        it.sku(), f.recargoPorcentajeMaquinaria(), f.aplicaIvaMaquinaria()));
            }
        }
        return new GenerarPresupuestoRequestDTO(
                datos.clienteNombre(), datos.clienteTelefono(), datos.clienteEmail(),
                datos.rubro(), datos.observaciones(), datos.descuentoGlobalPorcentaje(),
                // En individual el id de forma elegida no aplica (cada ítem
                // lista sus propias formas) — se descarta.
                true, null, datos.origenAtencionSesionId(), datos.items(), formasIndividuales);
    }

    /** Deduplica formas de pago snapshot: en modo individual el JSON
     *  guarda N × M (N forms × M items); para usar como template necesitamos
     *  solo un snapshot por forma única. Identificamos por {@code id} si
     *  está, sino por {@code nombre} + {@code cantidadCuotas}. */
    private List<GenerarPresupuestoRequestDTO.FormaPagoSnapshot> deduplicarFormas(
            List<GenerarPresupuestoRequestDTO.FormaPagoSnapshot> formas) {
        if (formas == null) return List.of();
        java.util.LinkedHashMap<String, GenerarPresupuestoRequestDTO.FormaPagoSnapshot> unicas =
                new java.util.LinkedHashMap<>();
        for (GenerarPresupuestoRequestDTO.FormaPagoSnapshot f : formas) {
            String key = f.id() != null
                    ? "id:" + f.id()
                    : "nm:" + f.nombre() + "/" + f.cantidadCuotas();
            unicas.putIfAbsent(key, f);
        }
        return new java.util.ArrayList<>(unicas.values());
    }

    /** Reconstruye el DTO original a partir de los JSONs persistidos en
     *  el entity — útil para regenerar el PDF sin pedir el body al
     *  cliente. Si la deserialización falla (JSON corrupto, schema
     *  evolucionado), devuelve un DTO con listas vacías. */
    private GenerarPresupuestoRequestDTO rehidratarDatos(PresupuestoComercial p) {
        List<GenerarPresupuestoRequestDTO.Item> items = leerJson(
                p.getItemsJson(),
                new tools.jackson.core.type.TypeReference<List<GenerarPresupuestoRequestDTO.Item>>() {});
        List<GenerarPresupuestoRequestDTO.FormaPagoSnapshot> formas = leerJson(
                p.getFormasPagoJson(),
                new tools.jackson.core.type.TypeReference<List<GenerarPresupuestoRequestDTO.FormaPagoSnapshot>>() {});
        // El flag `cotizacionIndividual` no se persiste explícitamente en la
        // entity — lo inferimos de los snapshots de formas de pago: si alguno
        // trae `itemSku` poblado, el presupuesto se generó en modo individual.
        // Esto permite regenerar el PDF idéntico al original sin guardar el
        // flag aparte.
        boolean individual = formas != null && formas.stream()
                .anyMatch(f -> f.itemSku() != null);
        return new GenerarPresupuestoRequestDTO(
                p.getClienteNombre(),
                p.getClienteTelefono(),
                p.getClienteEmail(),
                p.getRubro(),
                p.getObservaciones(),
                p.getDescuentoGlobalPorcentaje(),
                individual,
                p.getFormaPagoSeleccionadaId(),
                null,
                items == null ? List.of() : items,
                formas == null ? List.of() : formas);
    }

    private <T> T leerJson(String json, tools.jackson.core.type.TypeReference<T> typeRef) {
        if (json == null || json.isBlank()) return null;
        try {
            return mapper.readValue(json, typeRef);
        } catch (Exception e) {
            log.warn("No se pudo deserializar JSON del presupuesto: {}", e.getMessage());
            return null;
        }
    }

    private PresupuestoListItemDTO toListItemDTO(PresupuestoComercial p, String creadoPor) {
        return new PresupuestoListItemDTO(
                p.getId(),
                p.getCreadoAt(),
                p.getModificadoAt(),
                p.getClienteNombre(),
                p.getClienteTelefono(),
                p.getClienteEmail(),
                p.getRubro(),
                p.getSubtotalSinIva(),
                p.getDescuentoGlobalPorcentaje(),
                creadoPor,
                p.getConvertidoEnPedidoId(),
                p.getConvertidoAt(),
                p.getTotalFormaSeleccionada(),
                p.getFormaPagoSeleccionadaNombre());
    }

    /**
     * Marca este presupuesto como "convertido en pedido" — registra el id
     * del pedido DUX que se creó a partir del presupuesto. El historial
     * muestra el pill "→ Pedido #N".
     *
     * <p>Validaciones:
     * <ul>
     *   <li>El {@code pedidoId} debe existir en la tabla de pedidos. Sin esto
     *       un curl con un id inventado dejaría el pill apuntando a un
     *       pedido fantasma y el deep-link mostraría la lista vacía.</li>
     *   <li>Si ya está marcado con el MISMO {@code pedidoId}, no-op (re-llamada
     *       idempotente, ej. retry del frontend tras un timeout).</li>
     *   <li>Si ya está marcado con OTRO {@code pedidoId}, falla con 409
     *       Conflict — el operador tiene que desbloquear manualmente desde
     *       la BD para evitar perder el rastro del pedido original. Caso
     *       real solo se da en una race entre dos operadores con el dialog
     *       abierto a la vez sobre el mismo presupuesto.</li>
     * </ul>
     */
    @Transactional
    public void marcarConvertido(Long presupuestoId, Long pedidoId) {
        PresupuestoComercial p = obtener(presupuestoId);
        if (!pedidoRepository.existsById(pedidoId)) {
            throw new ConflictException(
                    "El pedido " + pedidoId + " no existe — no se puede vincular al presupuesto " + presupuestoId);
        }
        Long existente = p.getConvertidoEnPedidoId();
        if (existente != null && !existente.equals(pedidoId)) {
            throw new ConflictException(
                    "El presupuesto " + presupuestoId + " ya fue convertido en el pedido " + existente
                    + ". Para vincularlo a otro, hay que limpiar manualmente la marca desde la BD.");
        }
        if (existente == null) {
            p.setConvertidoEnPedidoId(pedidoId);
            p.setConvertidoAt(Instant.now());
            repository.save(p);
        }
    }

    /**
     * Regenera el pedido de un presupuesto que ya fue convertido y luego editado.
     * Crea un pedido NUEVO en DUX con los datos editados, anula el anterior
     * (solo local — DUX no expone anulación de comprobantes; el operador lo
     * cancela a mano) y re-vincula el presupuesto al pedido nuevo.
     *
     * <p>Atómico ante fallo de DUX: si el alta del nuevo pedido NO termina en
     * {@link EstadoPedido#ENVIADO}, no se toca el pedido anterior ni el vínculo
     * — el presupuesto sigue apuntando al pedido original.
     *
     * @return la respuesta del alta del nuevo pedido (el frontend la consume
     *         igual que en la creación normal).
     */
    @Transactional
    public CrearPedidoResponseDTO regenerarPedido(Long presupuestoId, CrearPedidoRequestDTO request,
                                                  String clientId, String username) {
        PresupuestoComercial p = obtener(presupuestoId);
        Long viejoId = p.getConvertidoEnPedidoId();
        if (viejoId == null) {
            throw new ConflictException(
                    "El presupuesto " + presupuestoId + " no tiene un pedido generado — no hay nada que regenerar.");
        }
        // Alta del nuevo pedido (reusa la lógica de creación + envío a DUX).
        // tratarComoRegeneracion=true: forzamos omitir la asociación de sesión de
        // atención y el PDF de follow-up sin depender de que el request traiga
        // origenPresupuesto. Sin esto, regenerar cerraría la atención ACTIVA del
        // operador (conversión fantasma) si el frontend olvidara el flag — misma
        // garantía que EdicionPedidoService.
        CrearPedidoResponseDTO res = pedidoService.crearPedido(request, clientId, username, true);
        // Solo si DUX aceptó el nuevo pedido tocamos el anterior y el vínculo.
        if (res.estado() == EstadoPedido.ENVIADO && res.pedidoLocalId() != null) {
            Long nuevoId = res.pedidoLocalId();
            // Anular el anterior solo si no estaba ya anulado (evita la
            // ConflictException de anularPedido, que marcaría la tx rollback-only).
            boolean viejoAnulable = pedidoRepository.findById(viejoId)
                    .map(ped -> ped.getEstado() != EstadoPedido.ANULADO)
                    .orElse(false);
            if (viejoAnulable) {
                pedidoService.anularPedido(viejoId,
                        "Regenerado: presupuesto #" + presupuestoId + " editado → pedido #" + nuevoId);
            }
            p.setConvertidoEnPedidoId(nuevoId);
            p.setConvertidoAt(Instant.now());
            repository.save(p);
            log.info("Presupuesto #{} regenerado: pedido viejo #{} {} → nuevo #{}",
                    presupuestoId, viejoId, viejoAnulable ? "anulado" : "(ya anulado)", nuevoId);
        }
        return res;
    }

    public Optional<String> motivoEmailNoConfigurado() {
        if (!emailEnabled) {
            return Optional.of("Envío de email deshabilitado (showroom.picking.email-enabled=false)");
        }
        if (mailSender == null) {
            return Optional.of("JavaMailSender no configurado (revisar spring.mail.* en application.properties)");
        }
        return Optional.empty();
    }

    /**
     * Public + invocado vía {@link #self} para que el proxy de Spring intercepte
     * y corra realmente en background. Si dejamos package-private + llamada
     * interna {@code this.enviarPorEmailAsync}, el aspect de @Async no se aplica
     * y el envío bloquea la respuesta del controller (PDF de varios MB por SMTP
     * tarda decenas de segundos).
     */
    @Async
    public void enviarPorEmailAsync(String destinatario, Long presupuestoId,
                                    String nombreCliente, byte[] pdf, String filename,
                                    String operador) {
        try {
            MimeMessage mime = mailSender.createMimeMessage();
            MimeMessageHelper helper = new MimeMessageHelper(mime, true, "UTF-8");

            String from = StringUtils.hasText(emailFrom) ? emailFrom : mailUsername;
            if (StringUtils.hasText(from)) helper.setFrom(from);
            helper.setTo(destinatario.split("\\s*,\\s*"));
            helper.setSubject(SUBJECT + presupuestoId);

            String nombre = StringUtils.hasText(nombreCliente) ? nombreCliente : "Cliente";
            helper.setText(plainBody(nombre, presupuestoId),
                    htmlBody(escapeHtml(nombre), presupuestoId));
            helper.addAttachment(filename, new ByteArrayResource(pdf));

            log.info("Email presupuesto #{} → {} ({} KB)",
                    presupuestoId, destinatario, pdf.length / 1024);
            mailSender.send(mime);
            publicarEvento(operador, Map.of(
                    "estado", "SENT",
                    "presupuestoId", presupuestoId,
                    "email", destinatario));
        } catch (Exception e) {
            if (esReadTimeoutPostUpload(e)) {
                // Mismo caso que en PickingEmailService: Gmail aceptó los datos
                // pero el ACK final tardó más que algún timeout intermedio. El
                // mail muy probablemente quedó encolado — lo reportamos como
                // ambiguo en vez de FAILED para no asustar al operador.
                log.warn("Email presupuesto #{} — Read timed out esperando ACK de Gmail "
                        + "(PDF={}KB). El mail probablemente se entregó: {}",
                        presupuestoId, pdf.length / 1024, e.getMessage());
                publicarEvento(operador, Map.of(
                        "estado", "AMBIGUO",
                        "presupuestoId", presupuestoId,
                        "email", destinatario,
                        "error", "Gmail tardó en confirmar el envío. El mail probablemente llegó — "
                                + "verificá la bandeja del cliente antes de reintentar."));
                return;
            }
            log.error("Falló envío de email del presupuesto #{}: {}",
                    presupuestoId, e.getMessage(), e);
            String detalle = UserMessages.traducir(e,
                    "No se pudo enviar el email. Revisar logs del backend.");
            publicarEvento(operador, Map.of(
                    "estado", "FAILED",
                    "presupuestoId", presupuestoId,
                    "email", destinatario,
                    "error", detalle));
        }
    }

    /** True si la causa raíz es un {@link SocketTimeoutException} — típico cuando
     *  el adjunto se subió OK pero Gmail no mandó el {@code 250 OK} a tiempo. */
    private static boolean esReadTimeoutPostUpload(Throwable t) {
        for (Throwable cur = t; cur != null; cur = cur.getCause()) {
            if (cur instanceof SocketTimeoutException) return true;
        }
        return false;
    }

    private PresupuestoComercial construirEntidad(GenerarPresupuestoRequestDTO datos) {
        PresupuestoComercial p = new PresupuestoComercial();
        p.setCreadoAt(Instant.now());
        aplicarDatos(p, datos);
        return p;
    }

    /** Copia los campos editables del DTO sobre la entity (cliente, items,
     *  formas, totales). NO toca {@code id}, {@code creadoAt},
     *  {@code modificadoAt}, {@code usuarioId} ni {@code eliminadoAt} — esos
     *  son responsabilidad del caller según el flujo (creación vs edición).
     *  El total se recalcula a partir de los items con sus descuentos
     *  individuales aplicados (ver feedback del 2026-05-20). */
    private void aplicarDatos(PresupuestoComercial p, GenerarPresupuestoRequestDTO datos) {
        // El campo `subtotalSinIva` de la entity ahora guarda el TOTAL EFECTIVO
        // (precio con la forma Efectivo según rubro, con descuentos individuales
        // aplicados) — es lo que se muestra como total en el historial. Se
        // conserva el nombre del campo para no migrar la columna. Para
        // presupuestos viejos sin `precioEfectivo` por ítem, cae al cálculo
        // anterior (total sin IVA) como fallback.
        BigDecimal subtotalSinIva = BigDecimal.ZERO;
        for (GenerarPresupuestoRequestDTO.Item it : datos.items()) {
            BigDecimal cantidad = it.cantidad() == null ? BigDecimal.ZERO : it.cantidad();
            BigDecimal precio = it.precioConIva() == null ? BigDecimal.ZERO : it.precioConIva();
            BigDecimal porcIva = it.porcIva() == null ? PrecioPerfilCalculator.IVA_DEFAULT : it.porcIva();
            BigDecimal desc = it.descuentoPorcentaje() == null ? BigDecimal.ZERO : it.descuentoPorcentaje();
            BigDecimal factorDesc = BigDecimal.ONE.subtract(desc.movePointLeft(2));

            BigDecimal totalLinea;
            if (it.precioReferencia() != null) {
                // Total de referencia: precioReferencia × (1 − desc) × cantidad.
                totalLinea = it.precioReferencia().multiply(factorDesc).multiply(cantidad);
            } else {
                // Fallback presupuestos viejos: total sin IVA.
                BigDecimal precioConDesc = precio.multiply(factorDesc);
                totalLinea = PrecioPerfilCalculator.calcularSinIva(precioConDesc, porcIva)
                        .multiply(cantidad);
            }
            subtotalSinIva = subtotalSinIva.add(totalLinea);
        }
        BigDecimal descGlobal = datos.descuentoGlobalPorcentaje() == null
                ? BigDecimal.ZERO
                : datos.descuentoGlobalPorcentaje();

        p.setClienteNombre(TextUtils.blankToNull(datos.clienteNombre()));
        p.setClienteTelefono(TextUtils.blankToNull(datos.clienteTelefono()));
        // Clave de agrupación por cliente — normalizada a solo dígitos, misma
        // que usa ClienteMaster. Se re-deriva en cada aplicarDatos (creación o
        // edición) por si el operador corrigió el teléfono al editar.
        p.setClienteTelefonoNormalizado(ClienteMasterService.normalizar(datos.clienteTelefono()));
        p.setClienteEmail(TextUtils.blankToNull(datos.clienteEmail()));
        p.setRubro(TextUtils.blankToNull(datos.rubro()));
        p.setObservaciones(TextUtils.blankToNull(datos.observaciones()));
        p.setDescuentoGlobalPorcentaje(descGlobal);
        p.setFormaPagoSeleccionadaId(datos.formaPagoSeleccionadaId());
        // Total + nombre de la forma elegida (snapshot, para la lista). Se toma
        // del `precioFinal`/`nombre` que ya manda el front en `formasPago`,
        // buscando la forma GLOBAL (itemSku null) por el id elegido. El filtro
        // `itemSku() == null` evita tomar un snapshot per-ítem en cotización
        // individual (N×M comparten id); hoy el front ya manda id null en
        // individual, pero el filtro lo deja robusto. Null cuando es "Todas".
        GenerarPresupuestoRequestDTO.FormaPagoSnapshot formaSel =
                (datos.formaPagoSeleccionadaId() != null && datos.formasPago() != null)
                        ? datos.formasPago().stream()
                                .filter(f -> datos.formaPagoSeleccionadaId().equals(f.id())
                                        && f.itemSku() == null)
                                .findFirst().orElse(null)
                        : null;
        p.setTotalFormaSeleccionada(formaSel != null ? formaSel.precioFinal() : null);
        p.setFormaPagoSeleccionadaNombre(formaSel != null ? formaSel.nombre() : null);
        p.setSubtotalSinIva(subtotalSinIva.setScale(2, RoundingMode.HALF_UP));
        // imagenUrl es solo de salida (se recalcula por SKU en obtenerDetalle);
        // se normaliza a null antes de persistir para no hornear una URL en el
        // JSON si el front la reenvía al editar.
        p.setItemsJson(escribirJson(sinImagenUrl(datos.items())));
        p.setFormasPagoJson(datos.formasPago() == null ? "[]" : escribirJson(datos.formasPago()));
    }

    private String escribirJson(Object o) {
        try {
            return mapper.writeValueAsString(o);
        } catch (Exception e) {
            log.warn("No se pudo serializar a JSON: {}", e.getMessage());
            return "[]";
        }
    }

    private static String plainBody(String nombre, Long id) {
        return """
                Hola %s,

                Te dejamos adjunto el presupuesto #%d que armamos en KT GASTRO.

                Cualquier consulta, estamos a disposición.

                Saludos,
                Equipo KT GASTRO
                """.formatted(nombre, id);
    }

    private static String htmlBody(String nombreEscapado, Long id) {
        return """
                <div style="font-family: Arial, Helvetica, sans-serif; color: #2d2d2d; max-width: 600px;">
                  <h2 style="color: #FF861C; margin: 0 0 16px 0; font-size: 20px;">
                    Hola %s,
                  </h2>
                  <p style="font-size: 14px; line-height: 1.6;">
                    Te dejamos adjunto el <strong>presupuesto #%d</strong> que armamos
                    para vos en KT GASTRO. Tiene el detalle de los productos elegidos y
                    las formas de pago disponibles.
                  </p>
                  <p style="font-size: 14px; line-height: 1.6;">
                    Cualquier consulta, estamos a disposición.
                  </p>
                  <p style="font-size: 14px; color: #5a5a5a; margin-top: 24px;">
                    Saludos,<br>
                    <strong style="color: #FF861C;">Equipo KT GASTRO</strong>
                  </p>
                </div>
                """.formatted(nombreEscapado, id);
    }

    private static String escapeHtml(String s) {
        if (s == null) return "";
        return s.replace("&", "&amp;")
                .replace("<", "&lt;").replace(">", "&gt;")
                .replace("\"", "&quot;");
    }

    /** Resultado de generar — incluye la entidad (persistida con ID en el flujo
     *  de envío, transitoria con id=null en el preview), el PDF en bytes y el
     *  nombre de archivo sugerido. */
    public record Resultado(PresupuestoComercial presupuesto, byte[] pdf, String nombreArchivo) {}
}
