package ar.com.leo.showroom.cliente.service;

import ar.com.leo.showroom.auth.repository.UsuarioRepository;
import ar.com.leo.showroom.cliente.entity.ClienteMaster;
import ar.com.leo.showroom.cliente.repository.ClienteMasterRepository;
import ar.com.leo.showroom.pedido.entity.PedidoShowroom;
import ar.com.leo.showroom.pedido.repository.PedidoShowroomRepository;
import ar.com.leo.showroom.presupuesto.entity.PresupuestoComercial;
import ar.com.leo.showroom.presupuesto.repository.PresupuestoComercialRepository;
import org.junit.jupiter.api.Test;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * Test unitario puro (sin Spring/DB) de la materialización de actividad del
 * cliente en {@link ClienteMasterService#recalcularActividad}. Cubre la lógica
 * de combinación presupuestos+pedidos: contadores, último/primer movimiento y
 * qué tipo de movimiento define el último total.
 */
class ClienteMasterActividadTest {

    private final ClienteMasterRepository masterRepo = mock(ClienteMasterRepository.class);
    private final UsuarioRepository usuarioRepo = mock(UsuarioRepository.class);
    private final PresupuestoComercialRepository presupuestoRepo = mock(PresupuestoComercialRepository.class);
    private final PedidoShowroomRepository pedidoRepo = mock(PedidoShowroomRepository.class);

    private final ClienteMasterService service = new ClienteMasterService(
            masterRepo, usuarioRepo, presupuestoRepo, pedidoRepo);

    private static final String TEL = "1112345678";

    private PresupuestoComercial presup(long id, Instant creadoAt, String subtotal) {
        return PresupuestoComercial.builder()
                .id(id).creadoAt(creadoAt).subtotalSinIva(new BigDecimal(subtotal)).build();
    }

    private PedidoShowroom pedido(long id, Instant creadoAt, String total) {
        return PedidoShowroom.builder()
                .id(id).creadoAt(creadoAt).totalSinIva(new BigDecimal(total)).build();
    }

    @Test
    void presupuestoMasRecienteQuePedido_defineUltimoMovimientoYTotal() {
        ClienteMaster master = ClienteMaster.builder().telefonoNormalizado(TEL).build();
        Instant t0 = Instant.parse("2026-01-01T00:00:00Z");
        Instant tPedido = Instant.parse("2026-02-01T00:00:00Z");
        Instant tPresup = Instant.parse("2026-03-01T00:00:00Z");

        when(masterRepo.findByTelefonoNormalizado(TEL)).thenReturn(Optional.of(master));
        when(presupuestoRepo.countByClienteTelefonoNormalizadoAndEliminadoAtIsNull(TEL)).thenReturn(2L);
        when(pedidoRepo.countByClienteTelefonoNormalizado(TEL)).thenReturn(1L);
        when(presupuestoRepo.findFirstByClienteTelefonoNormalizadoAndEliminadoAtIsNullOrderByCreadoAtDesc(TEL))
                .thenReturn(Optional.of(presup(10, tPresup, "500")));
        when(presupuestoRepo.findFirstByClienteTelefonoNormalizadoAndEliminadoAtIsNullOrderByCreadoAtAsc(TEL))
                .thenReturn(Optional.of(presup(7, t0, "100")));
        when(pedidoRepo.findFirstByClienteTelefonoNormalizadoOrderByCreadoAtDesc(TEL))
                .thenReturn(Optional.of(pedido(20, tPedido, "300")));
        when(pedidoRepo.findFirstByClienteTelefonoNormalizadoOrderByCreadoAtAsc(TEL))
                .thenReturn(Optional.of(pedido(20, tPedido, "300")));

        service.recalcularActividad(TEL);

        assertThat(master.getCantidadPresupuestos()).isEqualTo(2);
        assertThat(master.getCantidadPedidos()).isEqualTo(1);
        assertThat(master.getUltimoMovimientoAt()).isEqualTo(tPresup);
        assertThat(master.getUltimoTotalSinIva()).isEqualByComparingTo("500");
        assertThat(master.getUltimoPresupuestoId()).isEqualTo(10);
        assertThat(master.getUltimoPedidoId()).isEqualTo(20);
        assertThat(master.getPrimerMovimientoAt()).isEqualTo(t0);
        verify(masterRepo).save(master);
    }

    @Test
    void pedidoMasReciente_defineUltimoTotalDesdeElPedido() {
        ClienteMaster master = ClienteMaster.builder().telefonoNormalizado(TEL).build();
        Instant tPresup = Instant.parse("2026-02-01T00:00:00Z");
        Instant tPedido = Instant.parse("2026-03-01T00:00:00Z");

        when(masterRepo.findByTelefonoNormalizado(TEL)).thenReturn(Optional.of(master));
        when(presupuestoRepo.countByClienteTelefonoNormalizadoAndEliminadoAtIsNull(TEL)).thenReturn(1L);
        when(pedidoRepo.countByClienteTelefonoNormalizado(TEL)).thenReturn(1L);
        when(presupuestoRepo.findFirstByClienteTelefonoNormalizadoAndEliminadoAtIsNullOrderByCreadoAtDesc(TEL))
                .thenReturn(Optional.of(presup(10, tPresup, "500")));
        when(presupuestoRepo.findFirstByClienteTelefonoNormalizadoAndEliminadoAtIsNullOrderByCreadoAtAsc(TEL))
                .thenReturn(Optional.of(presup(10, tPresup, "500")));
        when(pedidoRepo.findFirstByClienteTelefonoNormalizadoOrderByCreadoAtDesc(TEL))
                .thenReturn(Optional.of(pedido(20, tPedido, "300")));
        when(pedidoRepo.findFirstByClienteTelefonoNormalizadoOrderByCreadoAtAsc(TEL))
                .thenReturn(Optional.of(pedido(20, tPedido, "300")));

        service.recalcularActividad(TEL);

        assertThat(master.getUltimoMovimientoAt()).isEqualTo(tPedido);
        assertThat(master.getUltimoTotalSinIva()).isEqualByComparingTo("300");
        assertThat(master.getPrimerMovimientoAt()).isEqualTo(tPresup);
    }

    @Test
    void clienteSoloConPresupuestos_dejaPedidoEnCeroYNulls() {
        ClienteMaster master = ClienteMaster.builder().telefonoNormalizado(TEL).build();
        Instant t = Instant.parse("2026-03-01T00:00:00Z");

        when(masterRepo.findByTelefonoNormalizado(TEL)).thenReturn(Optional.of(master));
        when(presupuestoRepo.countByClienteTelefonoNormalizadoAndEliminadoAtIsNull(TEL)).thenReturn(1L);
        when(pedidoRepo.countByClienteTelefonoNormalizado(TEL)).thenReturn(0L);
        when(presupuestoRepo.findFirstByClienteTelefonoNormalizadoAndEliminadoAtIsNullOrderByCreadoAtDesc(TEL))
                .thenReturn(Optional.of(presup(10, t, "500")));
        when(presupuestoRepo.findFirstByClienteTelefonoNormalizadoAndEliminadoAtIsNullOrderByCreadoAtAsc(TEL))
                .thenReturn(Optional.of(presup(10, t, "500")));
        when(pedidoRepo.findFirstByClienteTelefonoNormalizadoOrderByCreadoAtDesc(TEL))
                .thenReturn(Optional.empty());
        when(pedidoRepo.findFirstByClienteTelefonoNormalizadoOrderByCreadoAtAsc(TEL))
                .thenReturn(Optional.empty());

        service.recalcularActividad(TEL);

        assertThat(master.getCantidadPedidos()).isZero();
        assertThat(master.getUltimoPedidoId()).isNull();
        assertThat(master.getUltimoPresupuestoId()).isEqualTo(10);
        assertThat(master.getUltimoMovimientoAt()).isEqualTo(t);
    }

    @Test
    void sinMaster_esNoOp() {
        when(masterRepo.findByTelefonoNormalizado(TEL)).thenReturn(Optional.empty());

        service.recalcularActividad(TEL);

        verify(masterRepo, never()).save(any());
    }

    @Test
    void telefonoSinDigitos_esNoOp() {
        service.recalcularActividad("---");

        verify(masterRepo, never()).save(any());
    }
}
