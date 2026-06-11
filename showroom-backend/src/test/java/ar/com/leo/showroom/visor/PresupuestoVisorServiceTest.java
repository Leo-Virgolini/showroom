package ar.com.leo.showroom.visor;

import ar.com.leo.showroom.events.SyncEventService;
import ar.com.leo.showroom.presupuesto.dto.PresupuestoVisorDTO;
import org.junit.jupiter.api.Test;

import java.math.BigDecimal;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;

/**
 * Test unitario puro (sin contexto Spring) del {@link PresupuestoVisorService}:
 * guardar/recuperar el snapshot en memoria y publicar al canal correcto.
 */
class PresupuestoVisorServiceTest {

    private final SyncEventService eventService = mock(SyncEventService.class);
    private final PresupuestoVisorService service = new PresupuestoVisorService(eventService);

    @Test
    void publicar_guardaSnapshotYEmiteAlOperador() {
        PresupuestoVisorDTO snap = new PresupuestoVisorDTO(
                "Juan", List.of(), new BigDecimal("100"), List.of());

        service.publicar("leo", snap);

        assertThat(service.obtener("leo")).isEqualTo(snap);
        verify(eventService).publishTo("leo", PresupuestoVisorService.EVENTO, snap);
    }

    @Test
    void publicar_conUsernameBlank_esNoOp() {
        service.publicar("   ", PresupuestoVisorDTO.vacio());

        verifyNoInteractions(eventService);
    }

    @Test
    void obtener_sinSnapshotPrevio_devuelveVacio() {
        PresupuestoVisorDTO r = service.obtener("desconocido");

        assertThat(r.clienteNombre()).isNull();
        assertThat(r.items()).isEmpty();
        assertThat(r.formasPago()).isEmpty();
        assertThat(r.total()).isEqualByComparingTo(BigDecimal.ZERO);
    }
}
