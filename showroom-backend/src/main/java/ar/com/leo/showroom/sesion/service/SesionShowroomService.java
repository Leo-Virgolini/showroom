package ar.com.leo.showroom.sesion.service;

import ar.com.leo.showroom.auth.entity.Usuario;
import ar.com.leo.showroom.auth.repository.UsuarioRepository;
import ar.com.leo.showroom.catalogo.service.ImagenLocalService;
import ar.com.leo.showroom.common.exception.GoneException;
import ar.com.leo.showroom.common.exception.NotFoundException;
import ar.com.leo.showroom.events.SesionCerradaEvent;
import ar.com.leo.showroom.events.SyncEventService;
import ar.com.leo.showroom.pedido.entity.EstadoPedido;
import ar.com.leo.showroom.pedido.repository.PedidoShowroomRepository;
import ar.com.leo.showroom.sesion.dto.SesionDetalleDTO;
import ar.com.leo.showroom.sesion.dto.SesionListItemDTO;
import ar.com.leo.showroom.sesion.dto.SesionListPageDTO;
import ar.com.leo.showroom.sesion.dto.SesionScanItemDTO;
import ar.com.leo.showroom.sesion.dto.SesionShowroomDTO;
import ar.com.leo.showroom.sesion.entity.SesionScanItem;
import ar.com.leo.showroom.sesion.entity.SesionShowroom;
import ar.com.leo.showroom.sesion.repository.SesionShowroomRepository;
import ar.com.leo.showroom.showroom.dto.ScanResultDTO;
import jakarta.transaction.Transactional;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.security.SecureRandom;
import java.time.Instant;
import java.util.Base64;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * Gestiona las sesiones de atención del showroom — guarda lo que el cliente
 * VE durante la visita (todos los SKUs escaneados), separado del carrito que
 * son los que efectivamente COMPRA.
 *
 * <p><b>Multi-usuario</b>: cada operador tiene su propia sesión activa. Iniciar
 * una nueva sesión finaliza la anterior DEL MISMO operador (no la de otros).
 * "Activa" = {@code usuarioId = X AND finalizadaAt IS NULL}.
 *
 * <p>Los scans se registran via {@link #registrarScan(String, ScanResultDTO)}
 * llamado desde el endpoint {@code /scan/{sku}}. Si el operador no tiene sesión
 * activa, el scan sigue funcionando normalmente pero no se persiste.
 *
 * <p>Persistencia: tabla {@code sesion_showroom} + {@code sesion_scan_item}.
 * Restart del backend no pierde nada — a diferencia del carrito.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class SesionShowroomService {

    public static final String EVENTO_SESION = "sesion-updated";

    private static final SecureRandom RANDOM = new SecureRandom();

    private static String generarVisorToken() {
        byte[] bytes = new byte[32];
        RANDOM.nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    private final SesionShowroomRepository repository;
    private final SyncEventService eventService;
    private final ImagenLocalService imagenLocalService;
    private final PedidoShowroomRepository pedidoRepository;
    private final UsuarioRepository usuarioRepository;
    /** Lookup bulk de operadores (usuarioId → displayName) compartido por todos
     *  los listados. */
    private final ar.com.leo.showroom.auth.service.UsuarioService usuarioService;
    /** Para publicar {@link SesionCerradaEvent} cuando se abandona/cancela una
     *  sesión. {@code CarritoService} lo escucha y vacía el carrito — así
     *  evitamos el acoplamiento directo y el ciclo de dependencias. */
    private final ApplicationEventPublisher applicationEventPublisher;

    /**
     * Inicia una sesión nueva para {@code username} con el nombre del cliente.
     * Si había una activa del MISMO operador sin pedido asociado, la marca
     * como finalizada (abandonada). Las sesiones de otros operadores no se
     * tocan.
     *
     * @return el DTO de la nueva sesión activa.
     */
    @Transactional
    public SesionShowroomDTO iniciar(String username, String nombre) {
        Usuario operador = resolverOperador(username);
        String limpio = nombre == null ? "" : nombre.trim();
        if (limpio.isEmpty()) {
            throw new IllegalArgumentException("Nombre del cliente requerido");
        }

        repository.findActivaByUsuarioId(operador.getId()).ifPresent(activa -> {
            activa.setFinalizadaAt(Instant.now());
            repository.save(activa);
            // El carrito del operador se vacía con el listener. Otros operadores
            // y sus carritos no se ven afectados.
            applicationEventPublisher.publishEvent(new SesionCerradaEvent(
                    activa.getId(), activa.getNombre(), username, SesionCerradaEvent.Motivo.ABANDONADA));
            eventService.cerrarVisores(username);
            log.info("Sesión {} ({}, op={}) abandonada al iniciar una nueva",
                    activa.getId(), activa.getNombre(), username);
        });

        SesionShowroom nueva = SesionShowroom.builder()
                .usuarioId(operador.getId())
                .nombre(limpio)
                .iniciadaAt(Instant.now())
                .visorToken(generarVisorToken())
                .build();
        nueva = repository.save(nueva);
        log.info("Sesión {} iniciada por '{}' para cliente '{}'",
                nueva.getId(), username, limpio);

        SesionShowroomDTO dto = toEstadoDTO(nueva);
        eventService.publishTo(username, EVENTO_SESION, dto);
        return dto;
    }

    /**
     * Cierra la sesión activa de {@code username} sin asociarla a ningún pedido.
     * Idempotente — si no había sesión activa, devuelve el placeholder
     * inactiva sin tocar nada.
     */
    @Transactional
    public SesionShowroomDTO cancelar(String username) {
        Usuario operador = resolverOperador(username);
        Optional<SesionShowroom> activa = repository.findActivaByUsuarioId(operador.getId());
        if (activa.isEmpty()) {
            return SesionShowroomDTO.inactiva();
        }
        SesionShowroom s = activa.get();
        s.setFinalizadaAt(Instant.now());
        repository.save(s);
        applicationEventPublisher.publishEvent(new SesionCerradaEvent(
                s.getId(), s.getNombre(), username, SesionCerradaEvent.Motivo.CANCELADA));
        eventService.cerrarVisores(username);
        log.info("Sesión {} ({}, op={}) cancelada manualmente",
                s.getId(), s.getNombre(), username);
        eventService.publishTo(username, EVENTO_SESION, SesionShowroomDTO.inactiva());
        return SesionShowroomDTO.inactiva();
    }

    /** Estado actual de la sesión del operador (o inactiva si no hay una). */
    @Transactional
    public SesionShowroomDTO obtenerActiva(String username) {
        Optional<Usuario> op = usuarioRepository.findByUsername(username);
        if (op.isEmpty()) return SesionShowroomDTO.inactiva();
        return repository.findActivaByUsuarioId(op.get().getId())
                .map(this::toEstadoDTO)
                .orElseGet(SesionShowroomDTO::inactiva);
    }

    /** Token del visor de la sesión activa del operador, o null si no hay una.
     *  Lo consume la app del operador (autenticada) para armar el QR. */
    @Transactional
    public String tokenDeSesionActiva(String username) {
        Optional<Usuario> op = usuarioRepository.findByUsername(username);
        if (op.isEmpty()) return null;
        return repository.findActivaByUsuarioId(op.get().getId())
                .map(SesionShowroom::getVisorToken)
                .orElse(null);
    }

    /** Resuelve el token público del visor al username del operador dueño de la
     *  sesión. 404 si el token no existe o es blank; 410 si la sesión ya cerró. */
    @Transactional
    public String resolverUsernamePorTokenActivo(String token) {
        if (token == null || token.isBlank()) {
            throw new NotFoundException("Código de visor inválido.");
        }
        SesionShowroom s = repository.findByVisorToken(token)
                .orElseThrow(() -> new NotFoundException("Código de visor inválido."));
        if (s.getFinalizadaAt() != null) {
            throw new GoneException("Esta atención finalizó. Pedí un nuevo código al vendedor.");
        }
        return usuarioRepository.findById(s.getUsuarioId())
                .map(Usuario::getUsername)
                .orElseThrow(() -> new NotFoundException("Operador del visor no encontrado."));
    }

    /**
     * Registra un scan en la sesión activa del operador si la hay. Idempotente
     * por SKU: si el SKU ya estaba registrado, actualiza el timestamp + el
     * snapshot de precio/descripción (último visto gana). Si no hay sesión
     * activa, no hace nada — el caller no necesita preocuparse.
     */
    @Transactional
    public void registrarScan(String username, ScanResultDTO scan) {
        if (scan == null || scan.sku() == null) return;
        if (username == null || username.isBlank()) return;
        Optional<Usuario> op = usuarioRepository.findByUsername(username);
        if (op.isEmpty()) return;
        Optional<SesionShowroom> activaOpt = repository.findActivaByUsuarioId(op.get().getId());
        if (activaOpt.isEmpty()) return;
        SesionShowroom activa = activaOpt.get();

        // Buscar si el SKU ya está en la sesión (carga los items lazily).
        SesionScanItem existente = activa.getItems().stream()
                .filter(it -> scan.sku().equals(it.getSku()))
                .findFirst()
                .orElse(null);

        if (existente != null) {
            existente.setEscaneadoAt(Instant.now());
            existente.setDescripcion(scan.descripcion());
            existente.setRubro(scan.rubro());
            existente.setPrecioConIva(scan.pvpKtGastroConIva());
            existente.setPorcIva(scan.porcIva());
        } else {
            SesionScanItem nuevo = SesionScanItem.builder()
                    .sesion(activa)
                    .sku(scan.sku())
                    .descripcion(scan.descripcion())
                    .rubro(scan.rubro())
                    .precioConIva(scan.pvpKtGastroConIva())
                    .porcIva(scan.porcIva())
                    .escaneadoAt(Instant.now())
                    .build();
            activa.getItems().add(nuevo);
        }
        repository.save(activa);
        // Broadcast lightweight: solo la cantidad cambió. El frontend no
        // necesita ver el detalle en vivo, solo saber que el contador subió.
        eventService.publishTo(username, EVENTO_SESION, toEstadoDTO(activa));
    }

    /**
     * Marca la sesión activa del operador como finalizada y la asocia al
     * pedido creado. No-op si no había sesión activa.
     *
     * @return la sesión finalizada con sus items hidratados, o vacío si no
     *         había sesión activa.
     */
    @Transactional
    public Optional<SesionShowroom> finalizarConPedido(String username, Long pedidoId) {
        if (username == null || username.isBlank()) return Optional.empty();
        Optional<Usuario> op = usuarioRepository.findByUsername(username);
        if (op.isEmpty()) return Optional.empty();
        Optional<SesionShowroom> activaOpt = repository.findActivaByUsuarioId(op.get().getId());
        if (activaOpt.isEmpty()) return Optional.empty();
        SesionShowroom s = activaOpt.get();
        s.setFinalizadaAt(Instant.now());
        s.setPedidoId(pedidoId);
        // Tocar los items para hidratarlos antes de salir de la transacción —
        // el caller (email service async) los usa fuera del @Transactional.
        s.getItems().size();
        repository.save(s);
        eventService.cerrarVisores(username);
        log.info("Sesión {} ({}, op={}) finalizada con pedido {}",
                s.getId(), s.getNombre(), username, pedidoId);
        eventService.publishTo(username, EVENTO_SESION, SesionShowroomDTO.inactiva());
        return Optional.of(s);
    }

    /**
     * Marca la sesión activa del operador como finalizada y la asocia al
     * presupuesto comercial creado desde la atención. No-op si no había sesión
     * activa (el presupuesto se guarda igual, solo que sin cerrar sesión).
     *
     * <p>A diferencia de {@link #finalizarConPedido}, el carrito se vacía acá
     * mismo publicando {@link SesionCerradaEvent}: el presupuesto se guarda
     * desde el presupuestador (otra pantalla), así que el showroom no vacía su
     * propio carrito como sí hace tras crear un pedido.
     *
     * @return la sesión finalizada, o vacío si no había sesión activa.
     */
    @Transactional
    public Optional<SesionShowroom> finalizarConPresupuesto(String username, Long presupuestoId) {
        if (username == null || username.isBlank()) return Optional.empty();
        Optional<Usuario> op = usuarioRepository.findByUsername(username);
        if (op.isEmpty()) return Optional.empty();
        Optional<SesionShowroom> activaOpt = repository.findActivaByUsuarioId(op.get().getId());
        if (activaOpt.isEmpty()) return Optional.empty();
        SesionShowroom s = activaOpt.get();
        s.setFinalizadaAt(Instant.now());
        s.setPresupuestoId(presupuestoId);
        s.getItems().size();
        repository.save(s);
        // Vaciar el carrito del operador (el listener de CarritoService escucha
        // este evento). El pedido no lo necesita porque el showroom vacía su
        // carrito en el frontend; acá el guardado ocurre en otra pantalla.
        applicationEventPublisher.publishEvent(new SesionCerradaEvent(
                s.getId(), s.getNombre(), username, SesionCerradaEvent.Motivo.PRESUPUESTO));
        eventService.cerrarVisores(username);
        log.info("Sesión {} ({}, op={}) finalizada con presupuesto {}",
                s.getId(), s.getNombre(), username, presupuestoId);
        eventService.publishTo(username, EVENTO_SESION, SesionShowroomDTO.inactiva());
        return Optional.of(s);
    }

    /**
     * Whitelist de campos por los que se permite ordenar el listado de sesiones.
     * Mapea el nombre que manda el frontend (id de columna del p-table) al
     * atributo de la entity. Solo columnas que son campos directos de
     * SesionShowroom: "Operador" (usuarioId derivado), "Estado" (derivado del
     * pedido) y "Escaneados" (count de items) NO son ordenables. Evita "SQL
     * injection via sort field" al pasar el parámetro directo al ORDER BY.
     */
    private static final java.util.Map<String, String> SORT_SESIONES = java.util.Map.of(
            "iniciadaAt", "iniciadaAt",
            "nombre", "nombre",
            // La columna "Operador" usa `creadoPor` en el DTO; ordena por el
            // campo directo `usuarioId` de la entity (agrupa por operador).
            "creadoPor", "usuarioId",
            "pedidoId", "pedidoId");

    /** Listado paginado de sesiones (página /historial). Ordenado por inicio desc.
     *  Sin filtrar por usuario — el historial muestra todas las sesiones del
     *  showroom independientemente del operador (los listados gerenciales
     *  necesitan ver el global). Si en el futuro se quiere segmentar por
     *  operador, se agrega un filtro opcional.
     *
     *  <p>Carga el estado del pedido asociado en bulk para todas las sesiones
     *  de la página que tienen pedidoId — así el frontend puede mostrar si la
     *  sesión completada quedó luego anulada. Una sola query extra a
     *  pedido_showroom, sin N+1. */
    @Transactional
    public SesionListPageDTO listar(String q, Instant desde, Instant hasta, int page, int size,
                                    String sortField, String sortOrder) {
        int pageSafe = Math.max(0, page);
        int sizeSafe = Math.min(Math.max(size, 1), 200);
        // Resolver el sort: si el campo no está en la whitelist o no se pidió,
        // usar `iniciadaAt desc` (default histórico de la pantalla).
        Sort sort = ar.com.leo.showroom.common.util.SortUtils
                .resolver(SORT_SESIONES, sortField, sortOrder, "iniciadaAt");
        Page<SesionShowroom> resultado = repository.buscar(
                StringUtils.hasText(q) ? q.trim() : null,
                desde,
                hasta,
                PageRequest.of(pageSafe, sizeSafe, sort)
        );

        // Estados de los pedidos de la página en una sola query.
        Set<Long> pedidoIds = resultado.getContent().stream()
                .map(SesionShowroom::getPedidoId)
                .filter(Objects::nonNull)
                .collect(Collectors.toSet());
        Map<Long, EstadoPedido> estadosByPedidoId = new HashMap<>();
        if (!pedidoIds.isEmpty()) {
            for (Object[] row : pedidoRepository.findEstadosByIds(pedidoIds)) {
                estadosByPedidoId.put((Long) row[0], (EstadoPedido) row[1]);
            }
        }

        // Bulk lookup de operadores: una sola query para resolver usuarioId
        // → display name de todos los operadores presentes en la página.
        Set<Long> usuarioIds = resultado.getContent().stream()
                .map(SesionShowroom::getUsuarioId)
                .filter(Objects::nonNull)
                .collect(Collectors.toSet());
        Map<Long, String> operadores = usuarioService.nombresPorId(usuarioIds);

        List<SesionListItemDTO> items = resultado.getContent().stream()
                .map(s -> toListItemDTO(s, estadosByPedidoId.get(s.getPedidoId()),
                        s.getUsuarioId() == null ? null : operadores.get(s.getUsuarioId())))
                .toList();
        return new SesionListPageDTO(items, resultado.getTotalElements(), pageSafe, sizeSafe);
    }

    /** Detalle completo con items, para la vista expandida en /historial.
     *
     *  <p>Si la sesión está asociada a un pedido, marca cada item con
     *  {@code compradoEnPedido} cruzando los SKUs escaneados contra los SKUs del
     *  pedido — distingue "vi pero no compré" de "compré". Una query extra
     *  liviana (solo SKUs) cuando hay pedido. */
    @Transactional
    public SesionDetalleDTO obtenerDetalle(Long id) {
        SesionShowroom s = repository.findByIdWithItems(id)
                .orElseThrow(() -> new NotFoundException("Sesión no encontrada: " + id));
        Set<String> skusComprados = s.getPedidoId() == null
                ? Collections.emptySet()
                : new HashSet<>(pedidoRepository.findSkusByPedidoId(s.getPedidoId()));
        List<SesionScanItemDTO> itemDtos = s.getItems().stream()
                .sorted(Comparator.comparing(SesionScanItem::getEscaneadoAt))
                .map(it -> toItemDTO(it, skusComprados.contains(it.getSku())))
                .toList();
        return new SesionDetalleDTO(
                s.getId(), s.getNombre(), s.getIniciadaAt(), s.getFinalizadaAt(),
                s.getPedidoId(), itemDtos);
    }

    // =====================================================
    // Helpers
    // =====================================================

    /** Resuelve el username al Usuario o lanza 404 si no existe. */
    private Usuario resolverOperador(String username) {
        if (username == null || username.isBlank()) {
            throw new NotFoundException("Operador no identificado");
        }
        return usuarioRepository.findByUsername(username)
                .orElseThrow(() -> new NotFoundException("Operador no encontrado: " + username));
    }

    // =====================================================
    // Mappers
    // =====================================================

    private SesionShowroomDTO toEstadoDTO(SesionShowroom s) {
        return new SesionShowroomDTO(
                s.getId(),
                s.getNombre(),
                s.getIniciadaAt(),
                s.getFinalizadaAt(),
                s.getPedidoId(),
                s.getItems() == null ? 0 : s.getItems().size()
        );
    }

    private SesionListItemDTO toListItemDTO(SesionShowroom s, EstadoPedido estadoPedido,
                                            String creadoPor) {
        return new SesionListItemDTO(
                s.getId(),
                s.getNombre(),
                s.getIniciadaAt(),
                s.getFinalizadaAt(),
                s.getPedidoId(),
                estadoPedido,
                s.getItems() == null ? 0 : s.getItems().size(),
                creadoPor
        );
    }

    private SesionScanItemDTO toItemDTO(SesionScanItem it, boolean compradoEnPedido) {
        return new SesionScanItemDTO(
                it.getId(),
                it.getSku(),
                it.getDescripcion(),
                it.getRubro(),
                it.getPrecioConIva(),
                it.getPorcIva(),
                imagenLocalService.buscar(it.getSku()).isPresent()
                        ? "/api/showroom/productos/" + it.getSku() + "/imagen"
                        : null,
                it.getEscaneadoAt(),
                compradoEnPedido
        );
    }
}
