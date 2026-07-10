package ar.com.leo.showroom.events;

import lombok.extern.slf4j.Slf4j;
import org.springframework.scheduling.annotation.Scheduled;
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
 * globales. Esto le permite a la pantalla {@code /visor/t/{token}} ligarse
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
        return subscribe(username, Tipo.OPERADOR);
    }

    /** Suscribe el stream de un celular-visor ligado a {@code username}. Igual
     *  que {@link #subscribe(String)} pero marcado VISOR para poder cortarlo en
     *  {@link #cerrarVisores(String)} cuando la sesión de atención se cierra. */
    public SseEmitter subscribeVisor(String username) {
        return subscribe(username, Tipo.VISOR);
    }

    private SseEmitter subscribe(String username, Tipo tipo) {
        SseEmitter emitter = new SseEmitter(EMITTER_TIMEOUT_MS);
        Subscriber sub = new Subscriber(emitter, username, tipo);
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

    /**
     * Heartbeat periódico: envía un comentario SSE (línea {@code :hb}, que el
     * cliente ignora) a cada emitter. Cumple dos funciones:
     * <ul>
     *   <li>Detecta y remueve emitters muertos. Un visor/celular que se durmió o
     *       perdió la red sin cerrar el socket TCP nunca recibe un evento dirigido
     *       (los per-user solo llegan cuando hay actividad), así que su Subscriber
     *       quedaría para siempre en la lista reteniendo el async context de
     *       Tomcat. El {@code send} del heartbeat falla sobre el socket muerto y lo
     *       purga.</li>
     *   <li>Mantiene viva la conexión a través de proxies con idle-timeout.</li>
     * </ul>
     * Cada 20s: suficiente para purgar zombis sin generar tráfico notable.
     */
    @Scheduled(fixedDelay = 20_000L)
    public void heartbeat() {
        if (subscribers.isEmpty()) return;
        for (Subscriber s : subscribers) {
            try {
                s.emitter.send(SseEmitter.event().comment("hb"));
            } catch (Throwable t) {
                subscribers.remove(s);
                log.debug("Heartbeat: removí emitter SSE muerto ({}): {}", s.username, t.toString());
            }
        }
    }

    /**
     * Completa (desconecta) todos los emitters de tipo VISOR ligados a
     * {@code username}. Se llama al cerrar la sesión de atención: el celular
     * del cliente saliente se desconecta y, al reconectar con su token ya
     * inválido, recibe 410 y muestra "atención finalizada". Los emitters del
     * OPERADOR no se tocan.
     */
    public void cerrarVisores(String username) {
        if (username == null || username.isBlank()) return;
        for (Subscriber s : subscribers) {
            if (s.tipo == Tipo.VISOR && username.equals(s.username)) {
                subscribers.remove(s);
                try { s.emitter.complete(); } catch (Throwable ignored) { /* ya cerrado */ }
            }
        }
    }

    /** Distingue el stream del operador (su app autenticada) del stream del
     *  visor (celular del cliente) — ambos se suscriben con el mismo username,
     *  pero al cerrar la sesión solo hay que cortar los del visor. */
    public enum Tipo { OPERADOR, VISOR }

    private static final class Subscriber {
        final SseEmitter emitter;
        final String username;
        final Tipo tipo;
        Subscriber(SseEmitter emitter, String username, Tipo tipo) {
            this.emitter = emitter;
            this.username = username;
            this.tipo = tipo;
        }
    }
}
