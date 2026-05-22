package ar.com.leo.showroom.events;

import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.IOException;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * Bus de eventos Server-Sent Events. Soporta dos modos de publicación:
 *
 * <ul>
 *   <li><b>Global</b> ({@link #publish(String, Object)}): broadcast a todos
 *       los suscriptores conectados. Para eventos de sistema que afectan a
 *       cualquier operador (sync de catálogo, rate-limit DUX, etc.).</li>
 *   <li><b>Per-user</b> ({@link #publishTo(String, String, Object)}): solo a
 *       los suscriptores asociados al {@code username}. Para eventos que
 *       pertenecen al espacio personal de un operador — carrito, visor,
 *       sesión de atención. Sin este filtro, cada operador vería el carrito
 *       y los scans de los demás en su pantalla.</li>
 * </ul>
 *
 * <p>Un suscriptor se asocia a un username vía {@link #subscribe(String)}; un
 * suscriptor sin username (anonymous) NO recibe eventos per-user — solo los
 * globales. Esto le permite a la pantalla {@code /visor/{username}} ligarse
 * al canal del operador con solo pasar el path param.
 */
@Slf4j
@Service
public class SyncEventService {

    /** Sin timeout — el cliente decide cuándo desconectarse. */
    private static final long EMITTER_TIMEOUT_MS = 0L;

    private final List<Subscriber> subscribers = new CopyOnWriteArrayList<>();

    /** Suscribe sin asociar a un usuario — sólo recibirá eventos globales. */
    public SseEmitter subscribe() {
        return subscribe(null);
    }

    /**
     * Suscribe ligando el emitter al canal de {@code username}. Recibe tanto
     * los eventos globales como los publicados con {@link #publishTo}.
     * {@code username=null} equivale a {@link #subscribe()}.
     */
    public SseEmitter subscribe(String username) {
        SseEmitter emitter = new SseEmitter(EMITTER_TIMEOUT_MS);
        Subscriber sub = new Subscriber(emitter, username);
        emitter.onCompletion(() -> subscribers.remove(sub));
        emitter.onTimeout(() -> {
            subscribers.remove(sub);
            emitter.complete();
        });
        emitter.onError(t -> subscribers.remove(sub));
        subscribers.add(sub);

        // Evento "connected" inmediato — confirma al cliente que el stream
        // está vivo y flushea cualquier buffer intermedio.
        try {
            emitter.send(SseEmitter.event().name("connected").data("ok"));
        } catch (IOException e) {
            subscribers.remove(sub);
        }
        return emitter;
    }

    /**
     * Publica un evento a TODOS los suscriptores. Si alguno falla (cliente
     * cerró el browser, tablet se durmió), se remueve — el EventSource del
     * browser reconecta automáticamente.
     *
     * <p>Atrapamos {@code Throwable} (no solo Exception): {@code SseEmitter.send}
     * puede propagar errores del response chain de Tomcat que no son subclases
     * de Exception en todas las versiones; si se escapan suben hasta el
     * {@link ar.com.leo.showroom.common.exception.GlobalExceptionHandler} que
     * intenta devolver JSON sobre un response ya marcado como
     * {@code text/event-stream} — segundo error encadenado.
     */
    public void publish(String event, Object data) {
        log.debug("SSE publish global: event={}, clientes={}", event, subscribers.size());
        for (Subscriber s : subscribers) {
            send(s, event, data);
        }
    }

    /**
     * Publica solo a los suscriptores cuyo username coincide con {@code username}.
     * Si {@code username} es null/blank, no hace nada (preferimos un no-op
     * sobre confundirlo con broadcast global, que sería un bug silencioso).
     */
    public void publishTo(String username, String event, Object data) {
        if (username == null || username.isBlank()) return;
        int enviados = 0;
        for (Subscriber s : subscribers) {
            if (username.equals(s.username)) {
                send(s, event, data);
                enviados++;
            }
        }
        log.debug("SSE publish to {}: event={}, clientes={}", username, event, enviados);
    }

    private void send(Subscriber s, String event, Object data) {
        try {
            s.emitter.send(SseEmitter.event().name(event).data(data));
        } catch (Throwable t) {
            subscribers.remove(s);
            log.debug("Removí emitter SSE desconectado ({}): {}", s.username, t.toString());
        }
    }

    public int activeClients() {
        return subscribers.size();
    }

    /** Pareja emitter + username — el username puede ser null para suscriptores
     *  que solo reciben eventos globales. Usamos identidad de instancia para
     *  poder removerlo en los callbacks sin depender de equals(). */
    private static final class Subscriber {
        final SseEmitter emitter;
        final String username;
        Subscriber(SseEmitter emitter, String username) {
            this.emitter = emitter;
            this.username = username;
        }
    }
}
