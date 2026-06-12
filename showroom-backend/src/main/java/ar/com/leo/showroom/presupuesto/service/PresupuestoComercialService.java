package ar.com.leo.showroom.presupuesto.service;

import ar.com.leo.showroom.auth.repository.UsuarioRepository;
import ar.com.leo.showroom.cliente.entity.ClienteMaster;
import ar.com.leo.showroom.cliente.service.ClienteMasterService;
import ar.com.leo.showroom.common.exception.NotFoundException;
import ar.com.leo.showroom.common.exception.UserMessages;
import ar.com.leo.showroom.common.util.TextUtils;
import ar.com.leo.showroom.config.service.PrecioPerfilCalculator;
import ar.com.leo.showroom.events.SyncEventService;
import ar.com.leo.showroom.presupuesto.dto.ClientePresupuestosDTO;
import ar.com.leo.showroom.presupuesto.dto.GenerarPresupuestoRequestDTO;
import ar.com.leo.showroom.presupuesto.dto.PresupuestoDetalleDTO;
import ar.com.leo.showroom.presupuesto.dto.PresupuestoListItemDTO;
import ar.com.leo.showroom.presupuesto.dto.PresupuestoListPageDTO;
import ar.com.leo.showroom.presupuesto.entity.PresupuestoComercial;
import ar.com.leo.showroom.presupuesto.repository.PresupuestoComercialRepository;
import ar.com.leo.showroom.pedido.entity.EstadoPedido;
import ar.com.leo.showroom.showroom.dto.CrearPedidoRequestDTO;
import ar.com.leo.showroom.showroom.dto.CrearPedidoResponseDTO;
import ar.com.leo.showroom.showroom.service.ShowroomService;
import jakarta.mail.internet.MimeMessage;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Lazy;
import org.springframework.core.io.ByteArrayResource;
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
import java.util.LinkedHashMap;
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
    private final ar.com.leo.showroom.auth.service.UsuarioService usuarioService;
    /** Para unificar la vista de clientes con los pedidos (no solo
     *  presupuestos). El service lee pedidos directamente del repo y los
     *  agrupa junto con los presupuestos por teléfono normalizado. */
    private final ar.com.leo.showroom.pedido.repository.PedidoShowroomRepository pedidoRepository;
    /** Maestro editable de clientes — se mergea con los datos derivados del
     *  historial al armar la vista de /clientes (nombre/email/rubro del master
     *  pisan los del último movimiento). */
    private final ClienteMasterService clienteMasterService;
    /** Fórmula de precios por perfil (menaje/maquinaria), compartida con el
     *  showroom para que el presupuesto calcule las formas igual que el carrito. */
    private final PrecioPerfilCalculator precioPerfilCalculator;
    /** Para resolver los nombres de provincia/localidad de envío (los pedidos
     *  guardan solo los códigos) al armar la vista de /clientes. */
    private final ar.com.leo.showroom.catalogo.repository.ProvinciaRepository provinciaRepository;
    private final ar.com.leo.showroom.catalogo.repository.LocalidadRepository localidadRepository;

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
     * (alta + envío a DUX) y la anulación local de {@link ShowroomService}.
     * {@code @Lazy} para no introducir un ciclo en el arranque — ShowroomService
     * depende del REPO de presupuestos, no de este service.
     */
    @Autowired
    @Lazy
    private ShowroomService showroomService;

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
            ar.com.leo.showroom.auth.service.UsuarioService usuarioService,
            ar.com.leo.showroom.pedido.repository.PedidoShowroomRepository pedidoRepository,
            ClienteMasterService clienteMasterService,
            PrecioPerfilCalculator precioPerfilCalculator,
            ar.com.leo.showroom.catalogo.repository.ProvinciaRepository provinciaRepository,
            ar.com.leo.showroom.catalogo.repository.LocalidadRepository localidadRepository) {
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
        aplicarDatos(p, datos);
        p.setModificadoAt(Instant.now());
        p = repository.save(p);
        registrarClienteMaster(p, username);
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
                datos.items(),
                datos.formasPago());
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
        org.springframework.data.domain.Sort sort = ar.com.leo.showroom.common.util.SortUtils
                .resolver(SORT_PRESUPUESTOS, sortField, sortOrder, "creadoAt");
        org.springframework.data.domain.PageRequest pr =
                org.springframework.data.domain.PageRequest.of(page, size, sort);
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
     * Lista los clientes únicos que aparecen en presupuestos guardados,
     * agrupados por teléfono normalizado (solo dígitos). El teléfono es la
     * identidad canónica del cliente — antes era el email, pero como el email
     * dejó de ser obligatorio en {@code /presupuestos} (mayo 2026), pasamos
     * a usar teléfono que sí lo es. Presupuestos sin teléfono no se cuentan
     * en esta vista.
     *
     * <p>La normalización quita guiones, espacios y paréntesis del teléfono
     * antes de comparar — así {@code "11-12345678"} y {@code "1112345678"}
     * agrupan al mismo cliente aunque el operador haya tipeado distinto
     * formato en cada presupuesto.
     *
     * <p>Toma los datos (nombre, email, rubro) del presupuesto MÁS RECIENTE
     * como canónicos — si en uno viejo el operador tipeó mal un campo,
     * prevalece la última versión.
     *
     * <p>Devuelve la lista ordenada por último presupuesto descendente
     * (cliente más reciente primero). No paginamos en SQL: la cantidad de
     * clientes en /presupuestos es manejable y agrupar en memoria es más
     * simple que un GROUP BY con subqueries para "último monto" / "último id".
     */
    @Transactional
    public List<ClientePresupuestosDTO> listarClientes() {
        // La LISTA de clientes sale del MAESTRO (ClienteMaster) — fuente única.
        // El historial (presupuestos + pedidos) se usa SOLO para la actividad
        // (contadores, último movimiento, montos, deep-links) y, una única vez,
        // para sembrar el master de clientes legacy (backfill). Los DATOS del
        // cliente salen SIEMPRE del master, sin fallback al historial. Agrupamos
        // los movimientos por teléfono para esa actividad/backfill.
        Map<String, AgregadorCliente> agrupados = new LinkedHashMap<>();

        // 1. Presupuestos comerciales (excluidos los soft-deleted).
        for (PresupuestoComercial p : repository.findByEliminadoAtIsNullOrderByCreadoAtDesc()) {
            String clave = claveTelefono(p.getClienteTelefono());
            if (clave == null) continue;
            agrupados.computeIfAbsent(clave, k -> new AgregadorCliente()).agregarPresupuesto(p);
        }

        // 2. Pedidos. NO excluimos anulados — el contador es histórico (el
        // operador igual quiere ver "este cliente nos compró 3 veces" aunque
        // alguno haya quedado anulado por error).
        for (var pedido : pedidoRepository.findAll()) {
            String clave = claveTelefono(pedido.getTelefono());
            if (clave == null) continue;
            agrupados.computeIfAbsent(clave, k -> new AgregadorCliente()).agregarPedido(pedido);
        }

        // Self-heal / backfill lazy: aseguramos un master por cada teléfono con
        // movimientos. Los presupuestos/pedidos nuevos ya hacen upsert al master,
        // pero esto cubre los legacy creados antes de la unificación. NO se setea
        // CUIT/razón social acá (para no chocar el índice único de CUIT con datos
        // legacy potencialmente duplicados — el CUIT igual se muestra por fallback).
        Map<String, ClienteMaster> masters = clienteMasterService.cargarTodosIndexados();
        // CUITs ya asignados a algún master — para no chocar el índice único al
        // backfillear (varios teléfonos legacy podrían compartir CUIT).
        Set<Long> cuitsAsignados = masters.values().stream()
                .map(ClienteMaster::getNroDoc)
                .filter(Objects::nonNull)
                .collect(Collectors.toCollection(java.util.HashSet::new));
        for (var e : agrupados.entrySet()) {
            if (!masters.containsKey(e.getKey())) {
                AgregadorCliente a = e.getValue();
                // CUIT solo si no está ya asignado a otro master (add() devuelve
                // false si ya estaba) — evita la violación del índice único.
                Long cuit = (a.nroDoc != null && cuitsAsignados.add(a.nroDoc)) ? a.nroDoc : null;
                try {
                    ClienteMaster creado = clienteMasterService.ensureClienteBackfill(
                            e.getKey(), a.nombre, a.email, a.rubro,
                            a.tipoDoc, cuit, a.domicilio, a.codigoProvincia, a.idLocalidad);
                    masters.put(e.getKey(), creado);
                } catch (Exception ex) {
                    // Colisión rara (carga concurrente) — lo crea la otra request;
                    // este cliente aparece en la próxima carga. No rompe el listado.
                    log.warn("No se pudo crear el master del teléfono {}: {}", e.getKey(), ex.getMessage());
                }
            }
        }

        // La LISTA = masters (no eliminados). Cada fila usa los datos del master
        // (sin fallback al historial) + la actividad calculada arriba. Los
        // clientes con master eliminado (soft-delete) quedan fuera; los de alta
        // manual (sin movimientos) aparecen con la actividad en cero.
        List<ClientePresupuestosDTO> conMaster = masters.values().stream()
                .filter(m -> m.getEliminadoAt() == null)
                .map(m -> dtoDesdeMaster(m, agrupados.get(m.getTelefonoNormalizado())))
                .toList();

        // Resolución de nombres de provincia/localidad de envío. Se hace en
        // batch para no caer en N+1: una sola lectura de provincias (pocas) y
        // un findAllById de las localidades referenciadas.
        Map<String, String> provinciaPorCodIso = provinciaRepository.findAll().stream()
                .filter(p -> p.getCodIso() != null && p.getNombre() != null)
                .collect(Collectors.toMap(
                        p -> p.getCodIso().toLowerCase(),
                        ar.com.leo.showroom.catalogo.entity.Provincia::getNombre,
                        (a, b) -> a));
        Set<Long> idsLocalidad = conMaster.stream()
                .map(ClientePresupuestosDTO::idLocalidad)
                .map(PresupuestoComercialService::parseLongOrNull)
                .filter(Objects::nonNull)
                .collect(Collectors.toSet());
        Map<Long, String> localidadPorId = idsLocalidad.isEmpty()
                ? Map.of()
                : localidadRepository.findAllById(idsLocalidad).stream()
                        .collect(Collectors.toMap(
                                ar.com.leo.showroom.catalogo.entity.Localidad::getId,
                                ar.com.leo.showroom.catalogo.entity.Localidad::getNombre,
                                (a, b) -> a));

        // Ordenamos por última actividad descendente (cliente más reciente
        // arriba), independiente del orden de inserción.
        return conMaster.stream()
                .map(dto -> resolverUbicacion(dto, provinciaPorCodIso, localidadPorId))
                .sorted((a, b) -> {
                    if (a.ultimoMovimientoAt() == null) return 1;
                    if (b.ultimoMovimientoAt() == null) return -1;
                    return b.ultimoMovimientoAt().compareTo(a.ultimoMovimientoAt());
                })
                .toList();
    }

    /**
     * Arma el DTO de /clientes con los datos del MASTER ÚNICAMENTE — sin fallback
     * a presupuestos/pedidos (decisión del usuario: la tabla refleja solo lo que
     * está en el maestro). Lo ÚNICO que sale del historial es la ACTIVIDAD
     * (contadores, último movimiento, montos, deep-links); {@code act == null} =
     * cliente sin movimientos (alta manual) → ceros/nulls. El teléfono se muestra
     * normalizado (es lo que guarda el maestro). Los datos legacy ya fueron
     * copiados al maestro por el backfill, así que no hace falta el fallback.
     */
    private ClientePresupuestosDTO dtoDesdeMaster(ClienteMaster m, AgregadorCliente act) {
        return new ClientePresupuestosDTO(
                m.getEmail(),
                m.getTelefonoNormalizado(),
                m.getNombre(),
                m.getRubro(),
                act != null ? act.cantidadPresupuestos : 0,
                act != null ? act.cantidadPedidos : 0,
                act != null ? act.primerMovimientoAt : null,
                act != null ? act.canonicoCreadoAt : null,
                act != null ? act.ultimoTotalSinIva : null,
                act != null ? act.ultimoPresupuestoId : null,
                act != null ? act.ultimoPedidoId : null,
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
                dto.primerMovimientoAt(), dto.ultimoMovimientoAt(), dto.ultimoTotalSinIva(),
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

    /** Normaliza el teléfono a solo dígitos. Sin esto, "11-12345678" y
     *  "1112345678" agruparían como clientes distintos. Devuelve null si el
     *  teléfono está vacío o no tiene ningún dígito — esos movimientos no
     *  aparecen en la vista de clientes. */
    private static String claveTelefono(String telefono) {
        if (!StringUtils.hasText(telefono)) return null;
        String soloDigitos = telefono.replaceAll("\\D+", "");
        return soloDigitos.isEmpty() ? null : soloDigitos;
    }

    /** Agregador mutable usado durante el merge: acumula la ACTIVIDAD del cliente
     *  (contadores, último movimiento, montos, deep-links) y un snapshot de los
     *  datos del movimiento más reciente que usa el backfill para sembrar el
     *  master. El DTO final lo arma {@code dtoDesdeMaster} (la lista sale del
     *  maestro, no de acá). */
    private static final class AgregadorCliente {
        // Snapshot del movimiento más reciente (por creadoAt). Se usa SOLO para
        // sembrar el master en el backfill; la vista lee del master.
        private Instant canonicoCreadoAt;
        private String email;
        private String nombre;
        private String rubro;
        private java.math.BigDecimal ultimoTotalSinIva;

        // Contadores y referencias separadas por tipo.
        private int cantidadPresupuestos;
        private int cantidadPedidos;
        private Long ultimoPresupuestoId;
        private Long ultimoPedidoId;
        private Instant ultimoPresupuestoAt;
        private Instant ultimoPedidoAt;
        private Instant primerMovimientoAt;

        // Snapshot de facturación/envío del pedido MÁS RECIENTE. Va aparte del
        // canónico: el CUIT/envío solo existen en pedidos, así que aunque el
        // último movimiento sea un presupuesto (sin estos datos), mostramos los
        // del último pedido. Se actualizan en lock-step con ultimoPedidoAt.
        private String tipoDoc;
        private Long nroDoc;
        private String domicilio;
        private String codigoProvincia;
        private String idLocalidad;

        void agregarPresupuesto(PresupuestoComercial p) {
            cantidadPresupuestos++;
            // Cada presupuesto entrante puede ser el más reciente del cliente
            // dentro de su tipo — usamos eso para el deep-link a presupuestos.
            if (ultimoPresupuestoAt == null || p.getCreadoAt().isAfter(ultimoPresupuestoAt)) {
                ultimoPresupuestoAt = p.getCreadoAt();
                ultimoPresupuestoId = p.getId();
            }
            actualizarCanonicoSiMasNuevo(p.getCreadoAt(),
                    p.getClienteEmail(), p.getClienteNombre(), p.getRubro(),
                    p.getSubtotalSinIva());
            actualizarPrimerMovimiento(p.getCreadoAt());
        }

        void agregarPedido(ar.com.leo.showroom.pedido.entity.PedidoShowroom pedido) {
            cantidadPedidos++;
            if (ultimoPedidoAt == null || pedido.getCreadoAt().isAfter(ultimoPedidoAt)) {
                ultimoPedidoAt = pedido.getCreadoAt();
                ultimoPedidoId = pedido.getId();
                // Snapshot de facturación/envío del pedido más reciente.
                tipoDoc = pedido.getTipoDoc();
                nroDoc = pedido.getNroDoc();
                domicilio = pedido.getDomicilio();
                codigoProvincia = pedido.getCodigoProvincia();
                idLocalidad = pedido.getIdLocalidad();
            }
            // totalSinIva del pedido (no total con recargo) — coherente con
            // el total mostrado en presupuestos.
            actualizarCanonicoSiMasNuevo(pedido.getCreadoAt(),
                    pedido.getEmail(), pedido.getNombre(), pedido.getRubro(),
                    pedido.getTotalSinIva());
            actualizarPrimerMovimiento(pedido.getCreadoAt());
        }

        private void actualizarCanonicoSiMasNuevo(Instant creadoAt, String emailM,
                                                  String nombreM, String rubroM,
                                                  java.math.BigDecimal totalM) {
            if (canonicoCreadoAt != null && !creadoAt.isAfter(canonicoCreadoAt)) return;
            canonicoCreadoAt = creadoAt;
            email = emailM;
            nombre = nombreM;
            rubro = rubroM;
            ultimoTotalSinIva = totalM;
        }

        private void actualizarPrimerMovimiento(Instant creadoAt) {
            if (primerMovimientoAt == null || creadoAt.isBefore(primerMovimientoAt)) {
                primerMovimientoAt = creadoAt;
            }
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
                false, datos.items(), formasAgregadas);
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
        BigDecimal recargo = esMaq
                ? (f.recargoPorcentajeMaquinaria() != null ? f.recargoPorcentajeMaquinaria() : BigDecimal.ZERO)
                : (f.recargoPorcentaje() != null ? f.recargoPorcentaje() : BigDecimal.ZERO);
        boolean aplicaIva = esMaq
                ? Boolean.TRUE.equals(f.aplicaIvaMaquinaria())
                : !Boolean.FALSE.equals(f.aplicaIva());
        BigDecimal pf = PrecioPerfilCalculator.calcularPrecioFinal(totalLineaConIva(it), porcIva, recargo, aplicaIva);
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
                true, datos.items(), formasIndividuales);
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
                p.getConvertidoAt());
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
            throw new ar.com.leo.showroom.common.exception.ConflictException(
                    "El pedido " + pedidoId + " no existe — no se puede vincular al presupuesto " + presupuestoId);
        }
        Long existente = p.getConvertidoEnPedidoId();
        if (existente != null && !existente.equals(pedidoId)) {
            throw new ar.com.leo.showroom.common.exception.ConflictException(
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
            throw new ar.com.leo.showroom.common.exception.ConflictException(
                    "El presupuesto " + presupuestoId + " no tiene un pedido generado — no hay nada que regenerar.");
        }
        // Alta del nuevo pedido (reusa la lógica de creación + envío a DUX).
        CrearPedidoResponseDTO res = showroomService.crearPedido(request, clientId, username);
        // Solo si DUX aceptó el nuevo pedido tocamos el anterior y el vínculo.
        if (res.estado() == EstadoPedido.ENVIADO && res.pedidoLocalId() != null) {
            Long nuevoId = res.pedidoLocalId();
            // Anular el anterior solo si no estaba ya anulado (evita la
            // ConflictException de anularPedido, que marcaría la tx rollback-only).
            boolean viejoAnulable = pedidoRepository.findById(viejoId)
                    .map(ped -> ped.getEstado() != EstadoPedido.ANULADO)
                    .orElse(false);
            if (viejoAnulable) {
                showroomService.anularPedido(viejoId,
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
        p.setClienteEmail(TextUtils.blankToNull(datos.clienteEmail()));
        p.setRubro(TextUtils.blankToNull(datos.rubro()));
        p.setObservaciones(TextUtils.blankToNull(datos.observaciones()));
        p.setDescuentoGlobalPorcentaje(descGlobal);
        p.setSubtotalSinIva(subtotalSinIva.setScale(2, RoundingMode.HALF_UP));
        p.setItemsJson(escribirJson(datos.items()));
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
