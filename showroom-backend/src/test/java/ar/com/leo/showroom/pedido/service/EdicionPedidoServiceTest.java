package ar.com.leo.showroom.pedido.service;

import ar.com.leo.showroom.pedido.entity.EstadoPedido;
import ar.com.leo.showroom.pedido.entity.PedidoShowroom;
import ar.com.leo.showroom.pedido.repository.PedidoShowroomRepository;
import ar.com.leo.showroom.presupuesto.entity.PresupuestoComercial;
import ar.com.leo.showroom.presupuesto.repository.PresupuestoComercialRepository;
import ar.com.leo.showroom.sesion.entity.SesionShowroom;
import ar.com.leo.showroom.sesion.repository.SesionShowroomRepository;
import ar.com.leo.showroom.showroom.dto.CrearPedidoRequestDTO;
import ar.com.leo.showroom.showroom.dto.CrearPedidoResponseDTO;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class EdicionPedidoServiceTest {

    private final PedidoService pedidoService = mock(PedidoService.class);
    private final PedidoShowroomRepository pedidoRepository = mock(PedidoShowroomRepository.class);
    private final PresupuestoComercialRepository presupuestoRepository = mock(PresupuestoComercialRepository.class);
    private final SesionShowroomRepository sesionRepository = mock(SesionShowroomRepository.class);

    private final EdicionPedidoService service = new EdicionPedidoService(
            pedidoService, pedidoRepository, presupuestoRepository, sesionRepository);

    private final CrearPedidoRequestDTO request = mock(CrearPedidoRequestDTO.class);

    @Test
    void regenerar_conDuxOk_anulaViejoYTrasladaVinculos() {
        PedidoShowroom viejo = mock(PedidoShowroom.class);
        when(viejo.getEstado()).thenReturn(EstadoPedido.ENVIADO);
        when(pedidoRepository.findById(10L)).thenReturn(Optional.of(viejo));
        when(pedidoService.crearPedido(any(), eq("cli"), eq("leo"), eq(true)))
                .thenReturn(new CrearPedidoResponseDTO(20L, EstadoPedido.ENVIADO, Instant.now(), "ok"));

        PresupuestoComercial presu = mock(PresupuestoComercial.class);
        when(presupuestoRepository.findByConvertidoEnPedidoId(10L)).thenReturn(Optional.of(presu));
        SesionShowroom sesion = mock(SesionShowroom.class);
        when(sesionRepository.findByPedidoIdWithItems(10L)).thenReturn(Optional.of(sesion));

        CrearPedidoResponseDTO res = service.regenerarPedido(10L, request, "cli", "leo");

        assertThat(res.pedidoLocalId()).isEqualTo(20L);
        verify(pedidoService).anularPedido(eq(10L), any(String.class));
        verify(presu).setConvertidoEnPedidoId(20L);
        verify(presu).setConvertidoAt(any(Instant.class));
        verify(presupuestoRepository).save(presu);
        verify(sesion).setPedidoId(20L);
        verify(sesionRepository).save(sesion);
    }

    @Test
    void regenerar_conDuxError_noTocaElViejo() {
        PedidoShowroom viejo = mock(PedidoShowroom.class);
        when(viejo.getEstado()).thenReturn(EstadoPedido.ENVIADO);
        when(pedidoRepository.findById(10L)).thenReturn(Optional.of(viejo));
        when(pedidoService.crearPedido(any(), any(), any(), eq(true)))
                .thenReturn(new CrearPedidoResponseDTO(20L, EstadoPedido.ERROR, null, "DUX rechazó"));

        service.regenerarPedido(10L, request, "cli", "leo");

        verify(pedidoService, never()).anularPedido(any(), any());
        verify(presupuestoRepository, never()).save(any());
        verify(sesionRepository, never()).save(any());
    }

    @Test
    void regenerar_viejoYaAnulado_noReanulaPeroSiTrasladaVinculos() {
        PedidoShowroom viejo = mock(PedidoShowroom.class);
        when(viejo.getEstado()).thenReturn(EstadoPedido.ANULADO);
        when(pedidoRepository.findById(10L)).thenReturn(Optional.of(viejo));
        when(pedidoService.crearPedido(any(), any(), any(), eq(true)))
                .thenReturn(new CrearPedidoResponseDTO(20L, EstadoPedido.ENVIADO, Instant.now(), "ok"));

        PresupuestoComercial presu = mock(PresupuestoComercial.class);
        when(presupuestoRepository.findByConvertidoEnPedidoId(10L)).thenReturn(Optional.of(presu));
        SesionShowroom sesion = mock(SesionShowroom.class);
        when(sesionRepository.findByPedidoIdWithItems(10L)).thenReturn(Optional.of(sesion));

        service.regenerarPedido(10L, request, "cli", "leo");

        // Viejo ANULADO: no se re-anula, PERO los vínculos igual se trasladan al nuevo.
        verify(pedidoService, never()).anularPedido(any(), any());
        verify(presu).setConvertidoEnPedidoId(20L);
        verify(sesion).setPedidoId(20L);
    }
}
