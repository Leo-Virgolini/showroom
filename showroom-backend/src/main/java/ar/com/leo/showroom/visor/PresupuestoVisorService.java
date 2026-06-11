package ar.com.leo.showroom.visor;

import ar.com.leo.showroom.events.SyncEventService;
import ar.com.leo.showroom.presupuesto.dto.PresupuestoVisorDTO;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Visor read-only del armado de presupuestos — pantalla espejo para el celular
 * del cliente ({@code /visor-presupuesto/{username}}). A diferencia del
 * {@link VisorService} del showroom (que muestra producto-a-producto y no
 * mantiene estado), acá el cliente ve el carrito COMPLETO del presupuesto, así
 * que sí guardamos el último snapshot por operador: cuando el celular abre el
 * QR tarde, lo hidrata con {@link #obtener} sin esperar al próximo cambio.
 *
 * <p>El snapshot lo arma el frontend en cada cambio y lo publica vía
 * {@code POST /visor/presupuesto}; acá solo lo guardamos en memoria y lo
 * reemitimos por SSE ({@code presupuesto-visor}) al canal del operador. Sin
 * persistencia: un restart del backend vacía los snapshots (igual que el
 * carrito del showroom).
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class PresupuestoVisorService {

    public static final String EVENTO = "presupuesto-visor";

    private final SyncEventService eventService;

    /** Último snapshot publicado por cada operador (username → snapshot). */
    private final Map<String, PresupuestoVisorDTO> snapshots = new ConcurrentHashMap<>();

    /** Guarda el snapshot del operador y lo reemite por SSE a sus visores.
     *  No-op si {@code username} es null/blank (sin auth resuelta). */
    public void publicar(String username, PresupuestoVisorDTO snapshot) {
        if (username == null || username.isBlank()) return;
        PresupuestoVisorDTO snap = snapshot != null ? snapshot : PresupuestoVisorDTO.vacio();
        snapshots.put(username, snap);
        eventService.publishTo(username, EVENTO, snap);
    }

    /** Snapshot actual del operador para la hidratación inicial del visor, o
     *  uno vacío si todavía no publicó nada. */
    public PresupuestoVisorDTO obtener(String username) {
        return snapshots.getOrDefault(username, PresupuestoVisorDTO.vacio());
    }
}
