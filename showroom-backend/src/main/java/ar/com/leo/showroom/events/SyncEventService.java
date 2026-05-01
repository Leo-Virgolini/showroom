package ar.com.leo.showroom.events;

import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.IOException;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * Bus de eventos Server-Sent Events para notificar a todos los clientes
 * conectados sobre cambios de estado del backend (sync de catálogo, etc.).
 *
 * Cada cliente del frontend abre un EventSource a /api/showroom/events y
 * recibe eventos en tiempo real. Cuando se desconecta, el SseEmitter se
 * remueve de la lista vía los callbacks onCompletion/onTimeout/onError.
 */
@Slf4j
@Service
public class SyncEventService {

    /** Sin timeout — el cliente decide cuándo desconectarse. */
    private static final long EMITTER_TIMEOUT_MS = 0L;

    private final List<SseEmitter> emitters = new CopyOnWriteArrayList<>();

    public SseEmitter subscribe() {
        SseEmitter emitter = new SseEmitter(EMITTER_TIMEOUT_MS);
        emitter.onCompletion(() -> emitters.remove(emitter));
        emitter.onTimeout(() -> {
            emitters.remove(emitter);
            emitter.complete();
        });
        emitter.onError(t -> emitters.remove(emitter));
        emitters.add(emitter);

        // Mandamos un evento "connected" inmediatamente para que el cliente
        // sepa que la conexión está viva (y para flushear cualquier buffer
        // intermedio si hay un proxy adelante).
        try {
            emitter.send(SseEmitter.event().name("connected").data("ok"));
        } catch (IOException e) {
            emitters.remove(emitter);
        }
        return emitter;
    }

    /**
     * Publica un evento a todos los clientes conectados. Si alguno falla, se
     * remueve de la lista (el browser hace reconnect automático del EventSource).
     */
    public void publish(String event, Object data) {
        log.debug("SSE publish: event={}, clientes={}", event, emitters.size());
        for (SseEmitter e : emitters) {
            try {
                e.send(SseEmitter.event().name(event).data(data));
            } catch (Exception ex) {
                emitters.remove(e);
            }
        }
    }

    public int activeClients() {
        return emitters.size();
    }
}
