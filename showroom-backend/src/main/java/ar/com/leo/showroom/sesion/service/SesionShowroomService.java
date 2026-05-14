package ar.com.leo.showroom.sesion.service;

import ar.com.leo.showroom.catalogo.service.ImagenLocalService;
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

import java.time.Instant;
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
 * <p>Hay como máximo una sesión activa a la vez (igual que el carrito). Al
 * iniciar una nueva, la anterior se finaliza automáticamente (queda como
 * "abandonada" si no llegó a asociarse a un pedido).
 *
 * <p>Los scans se registran via {@link #registrarScan(ScanResultDTO)} llamado
 * desde el endpoint {@code /scan/{sku}}. Si no hay sesión activa, el scan
 * sigue funcionando normalmente pero no se persiste — el frontend muestra
 * un aviso al operador.
 *
 * <p>Persistencia: tabla {@code sesion_showroom} + {@code sesion_scan_item}.
 * Restart del backend no pierde nada — a diferencia del carrito.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class SesionShowroomService {

    public static final String EVENTO_SESION = "sesion-updated";

    private final SesionShowroomRepository repository;
    private final SyncEventService eventService;
    private final ImagenLocalService imagenLocalService;
    private final PedidoShowroomRepository pedidoRepository;
    /** Para publicar {@link SesionCerradaEvent} cuando se abandona/cancela una
     *  sesión. {@code CarritoService} lo escucha y vacía el carrito — así
     *  evitamos el acoplamiento directo y el ciclo de dependencias. */
    private final ApplicationEventPublisher applicationEventPublisher;

    /**
     * Inicia una sesión nueva con el nombre del cliente. Si había una activa
     * sin pedido asociado, la marca como finalizada (abandonada).
     *
     * @return el DTO de la nueva sesión activa.
     */
    @Transactional
    public SesionShowroomDTO iniciar(String nombre) {
        String limpio = nombre == null ? "" : nombre.trim();
        if (limpio.isEmpty()) {
            throw new IllegalArgumentException("Nombre del cliente requerido");
        }

        repository.findActiva().ifPresent(activa -> {
            activa.setFinalizadaAt(Instant.now());
            repository.save(activa);
            // El carrito es global — sin vaciar, el cliente nuevo hereda items
            // del anterior que no compró nada. Lo hace CarritoService al recibir
            // el evento.
            applicationEventPublisher.publishEvent(new SesionCerradaEvent(
                    activa.getId(), activa.getNombre(), SesionCerradaEvent.Motivo.ABANDONADA));
            log.info("Sesión {} ({}) abandonada al iniciar una nueva", activa.getId(), activa.getNombre());
        });

        SesionShowroom nueva = SesionShowroom.builder()
                .nombre(limpio)
                .iniciadaAt(Instant.now())
                .build();
        nueva = repository.save(nueva);
        log.info("Sesión {} iniciada para cliente '{}'", nueva.getId(), limpio);

        SesionShowroomDTO dto = toEstadoDTO(nueva);
        eventService.publish(EVENTO_SESION, dto);
        return dto;
    }

    /**
     * Cierra la sesión activa sin asociarla a ningún pedido (cancelación
     * manual desde el frontend). 204 si no había sesión activa — operación
     * idempotente.
     */
    @Transactional
    public SesionShowroomDTO cancelar() {
        Optional<SesionShowroom> activa = repository.findActiva();
        if (activa.isEmpty()) {
            return SesionShowroomDTO.inactiva();
        }
        SesionShowroom s = activa.get();
        s.setFinalizadaAt(Instant.now());
        repository.save(s);
        // El carrito es global — al cerrar la atención al cliente, queda vacío
        // para que el próximo cliente arranque limpio. Lo hace CarritoService
        // al recibir el evento.
        applicationEventPublisher.publishEvent(new SesionCerradaEvent(
                s.getId(), s.getNombre(), SesionCerradaEvent.Motivo.CANCELADA));
        log.info("Sesión {} ({}) cancelada manualmente", s.getId(), s.getNombre());
        eventService.publish(EVENTO_SESION, SesionShowroomDTO.inactiva());
        return SesionShowroomDTO.inactiva();
    }

    /** Estado actual de la sesión (o inactiva si no hay una). */
    @Transactional
    public SesionShowroomDTO obtenerActiva() {
        return repository.findActiva()
                .map(this::toEstadoDTO)
                .orElseGet(SesionShowroomDTO::inactiva);
    }

    /**
     * Registra un scan en la sesión activa si la hay. Idempotente por SKU:
     * si el SKU ya estaba registrado, actualiza el timestamp + el snapshot
     * de precio/descripción (último visto gana). Si no hay sesión activa,
     * no hace nada — el caller no necesita preocuparse.
     */
    @Transactional
    public void registrarScan(ScanResultDTO scan) {
        if (scan == null || scan.sku() == null) return;
        Optional<SesionShowroom> activaOpt = repository.findActiva();
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
            existente.setPrecioConIva(scan.pvpKtGastroConIva());
            existente.setPorcIva(scan.porcIva());
        } else {
            SesionScanItem nuevo = SesionScanItem.builder()
                    .sesion(activa)
                    .sku(scan.sku())
                    .descripcion(scan.descripcion())
                    .precioConIva(scan.pvpKtGastroConIva())
                    .porcIva(scan.porcIva())
                    .escaneadoAt(Instant.now())
                    .build();
            activa.getItems().add(nuevo);
        }
        repository.save(activa);
        // Broadcast lightweight: solo la cantidad cambió. El frontend no
        // necesita ver el detalle en vivo, solo saber que el contador subió.
        eventService.publish(EVENTO_SESION, toEstadoDTO(activa));
    }

    /**
     * Marca la sesión activa como finalizada y la asocia al pedido creado.
     * No-op si no había sesión activa.
     *
     * @return la sesión finalizada con sus items hidratados, o vacío si no
     *         había sesión activa.
     */
    @Transactional
    public Optional<SesionShowroom> finalizarConPedido(Long pedidoId) {
        Optional<SesionShowroom> activaOpt = repository.findActiva();
        if (activaOpt.isEmpty()) return Optional.empty();
        SesionShowroom s = activaOpt.get();
        s.setFinalizadaAt(Instant.now());
        s.setPedidoId(pedidoId);
        // Tocar los items para hidratarlos antes de salir de la transacción —
        // el caller (email service async) los usa fuera del @Transactional.
        s.getItems().size();
        repository.save(s);
        log.info("Sesión {} ({}) finalizada con pedido {}", s.getId(), s.getNombre(), pedidoId);
        eventService.publish(EVENTO_SESION, SesionShowroomDTO.inactiva());
        return Optional.of(s);
    }

    /** Listado paginado de sesiones (página /historial). Ordenado por inicio desc.
     *
     *  <p>Carga el estado del pedido asociado en bulk para todas las sesiones
     *  de la página que tienen pedidoId — así el frontend puede mostrar si la
     *  sesión completada quedó luego anulada. Una sola query extra a
     *  pedido_showroom, sin N+1. */
    @Transactional
    public SesionListPageDTO listar(String q, Instant desde, Instant hasta, int page, int size) {
        int pageSafe = Math.max(0, page);
        int sizeSafe = Math.min(Math.max(size, 1), 200);
        Page<SesionShowroom> resultado = repository.buscar(
                StringUtils.hasText(q) ? q.trim() : null,
                desde,
                hasta,
                PageRequest.of(pageSafe, sizeSafe, Sort.by(Sort.Direction.DESC, "iniciadaAt"))
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

        List<SesionListItemDTO> items = resultado.getContent().stream()
                .map(s -> toListItemDTO(s, estadosByPedidoId.get(s.getPedidoId())))
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

    private SesionListItemDTO toListItemDTO(SesionShowroom s, EstadoPedido estadoPedido) {
        return new SesionListItemDTO(
                s.getId(),
                s.getNombre(),
                s.getIniciadaAt(),
                s.getFinalizadaAt(),
                s.getPedidoId(),
                estadoPedido,
                s.getItems() == null ? 0 : s.getItems().size()
        );
    }

    private SesionScanItemDTO toItemDTO(SesionScanItem it, boolean compradoEnPedido) {
        return new SesionScanItemDTO(
                it.getId(),
                it.getSku(),
                it.getDescripcion(),
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
