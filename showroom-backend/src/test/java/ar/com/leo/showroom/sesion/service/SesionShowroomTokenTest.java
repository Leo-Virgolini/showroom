package ar.com.leo.showroom.sesion.service;

import ar.com.leo.showroom.auth.entity.Usuario;
import ar.com.leo.showroom.auth.repository.UsuarioRepository;
import ar.com.leo.showroom.catalogo.service.ImagenLocalService;
import ar.com.leo.showroom.common.exception.GoneException;
import ar.com.leo.showroom.common.exception.NotFoundException;
import ar.com.leo.showroom.events.SyncEventService;
import ar.com.leo.showroom.pedido.repository.PedidoShowroomRepository;
import ar.com.leo.showroom.sesion.entity.SesionShowroom;
import ar.com.leo.showroom.sesion.repository.SesionShowroomRepository;
import ar.com.leo.showroom.auth.service.UsuarioService;
import org.junit.jupiter.api.Test;
import org.springframework.context.ApplicationEventPublisher;

import java.time.Instant;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.*;

class SesionShowroomTokenTest {

    private final SesionShowroomRepository repository = mock(SesionShowroomRepository.class);
    private final SyncEventService eventService = mock(SyncEventService.class);
    private final ImagenLocalService imagenLocalService = mock(ImagenLocalService.class);
    private final PedidoShowroomRepository pedidoRepository = mock(PedidoShowroomRepository.class);
    private final UsuarioRepository usuarioRepository = mock(UsuarioRepository.class);
    private final UsuarioService usuarioService = mock(UsuarioService.class);
    private final ApplicationEventPublisher publisher = mock(ApplicationEventPublisher.class);

    private final SesionShowroomService service = new SesionShowroomService(
            repository, eventService, imagenLocalService, pedidoRepository,
            usuarioRepository, usuarioService, publisher);

    private Usuario operador(long id, String username) {
        Usuario u = new Usuario();
        u.setId(id);
        u.setUsername(username);
        u.setActivo(true);
        return u;
    }

    @Test
    void iniciar_generaTokenNoNuloEnLaSesionGuardada() {
        when(usuarioRepository.findByUsername("leo")).thenReturn(Optional.of(operador(1L, "leo")));
        when(repository.findActivaByUsuarioId(1L)).thenReturn(Optional.empty());
        when(repository.save(any(SesionShowroom.class))).thenAnswer(inv -> inv.getArgument(0));

        service.iniciar("leo", "Juan");

        verify(repository).save(argThat(s ->
                s.getVisorToken() != null && s.getVisorToken().length() >= 40));
    }

    @Test
    void resolverUsernamePorTokenActivo_devuelveUsernameSiEstaActiva() {
        SesionShowroom s = SesionShowroom.builder()
                .usuarioId(1L).nombre("Juan").iniciadaAt(Instant.now())
                .visorToken("tok123").build();
        when(repository.findByVisorToken("tok123")).thenReturn(Optional.of(s));
        when(usuarioRepository.findById(1L)).thenReturn(Optional.of(operador(1L, "leo")));

        assertThat(service.resolverUsernamePorTokenActivo("tok123")).isEqualTo("leo");
    }

    @Test
    void resolverUsernamePorTokenActivo_tokenDesconocido_404() {
        when(repository.findByVisorToken("nope")).thenReturn(Optional.empty());
        assertThatThrownBy(() -> service.resolverUsernamePorTokenActivo("nope"))
                .isInstanceOf(NotFoundException.class);
    }

    @Test
    void resolverUsernamePorTokenActivo_sesionFinalizada_410() {
        SesionShowroom s = SesionShowroom.builder()
                .usuarioId(1L).nombre("Juan").iniciadaAt(Instant.now())
                .finalizadaAt(Instant.now()).visorToken("tokFin").build();
        when(repository.findByVisorToken("tokFin")).thenReturn(Optional.of(s));

        assertThatThrownBy(() -> service.resolverUsernamePorTokenActivo("tokFin"))
                .isInstanceOf(GoneException.class);
    }

    @Test
    void cancelar_cierraLosVisoresDelOperador() {
        SesionShowroom s = SesionShowroom.builder()
                .usuarioId(1L).nombre("Juan").iniciadaAt(Instant.now()).visorToken("t").build();
        when(usuarioRepository.findByUsername("leo")).thenReturn(Optional.of(operador(1L, "leo")));
        when(repository.findActivaByUsuarioId(1L)).thenReturn(Optional.of(s));

        service.cancelar("leo");

        verify(eventService).cerrarVisores("leo");
    }
}
