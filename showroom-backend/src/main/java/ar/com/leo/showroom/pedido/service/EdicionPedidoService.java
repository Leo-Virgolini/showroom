package ar.com.leo.showroom.pedido.service;

import ar.com.leo.showroom.common.exception.NotFoundException;
import ar.com.leo.showroom.pedido.entity.EstadoPedido;
import ar.com.leo.showroom.pedido.entity.PedidoShowroom;
import ar.com.leo.showroom.pedido.repository.PedidoShowroomRepository;
import ar.com.leo.showroom.presupuesto.repository.PresupuestoComercialRepository;
import ar.com.leo.showroom.sesion.repository.SesionShowroomRepository;
import ar.com.leo.showroom.showroom.dto.CrearPedidoRequestDTO;
import ar.com.leo.showroom.showroom.dto.CrearPedidoResponseDTO;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;

/**
 * Edición de un pedido ya existente. DUX no permite editar/anular comprobantes, así
 * que "editar" = crear un pedido NUEVO en DUX con los datos editados + anular el
 * viejo localmente + trasladar sus vínculos de origen (presupuesto/sesión) al nuevo.
 * Mismo patrón que {@code PresupuestoComercialService.regenerarPedido}, pero pedido
 * → pedido (no crea ni persiste ningún presupuesto). Vive en un bean aparte (inyecta
 * {@link PedidoService}) para evitar self-invocation y ser testeable.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class EdicionPedidoService {

    private final PedidoService pedidoService;
    private final PedidoShowroomRepository pedidoRepository;
    private final PresupuestoComercialRepository presupuestoRepository;
    private final SesionShowroomRepository sesionRepository;

    @Transactional
    public CrearPedidoResponseDTO regenerarPedido(Long viejoId, CrearPedidoRequestDTO request,
                                                  String clientId, String username) {
        PedidoShowroom viejo = pedidoRepository.findById(viejoId)
                .orElseThrow(() -> new NotFoundException("Pedido no encontrado: " + viejoId));

        // tratarComoRegeneracion=true: el pedido nuevo no re-asocia sesión de
        // atención ni manda follow-up (el vínculo real se traslada abajo).
        CrearPedidoResponseDTO res = pedidoService.crearPedido(request, clientId, username, true);

        if (res.estado() == EstadoPedido.ENVIADO && res.pedidoLocalId() != null) {
            Long nuevoId = res.pedidoLocalId();
            // Guard: anular un pedido YA anulado lanza ConflictException que marca la
            // tx rollback-only (mismo motivo que en regenerarPedido de presupuestos).
            if (viejo.getEstado() != EstadoPedido.ANULADO) {
                pedidoService.anularPedido(viejoId,
                        "Editado: pedido #" + viejoId + " → pedido #" + nuevoId);
            }
            trasladarVinculos(viejoId, nuevoId);
            log.info("Pedido #{} editado → nuevo pedido #{} (viejo anulado localmente)",
                    viejoId, nuevoId);
        }
        return res;
    }

    /** Re-apunta el presupuesto y/o la sesión que referenciaban al pedido viejo. */
    private void trasladarVinculos(Long viejoId, Long nuevoId) {
        presupuestoRepository.findByConvertidoEnPedidoId(viejoId).ifPresent(p -> {
            p.setConvertidoEnPedidoId(nuevoId);
            p.setConvertidoAt(Instant.now());
            presupuestoRepository.save(p);
        });
        sesionRepository.findByPedidoIdWithItems(viejoId).ifPresent(s -> {
            s.setPedidoId(nuevoId);
            sesionRepository.save(s);
        });
    }
}
