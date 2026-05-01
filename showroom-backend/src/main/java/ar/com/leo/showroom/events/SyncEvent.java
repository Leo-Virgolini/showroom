package ar.com.leo.showroom.events;

import java.time.Instant;

/**
 * Payload de eventos del sync que se envían vía SSE a todos los clientes.
 * El frontend usa el `estado` para decidir si mostrar/ocultar el banner global.
 */
public record SyncEvent(
        Estado estado,
        Instant iniciadoAt,
        Integer items,
        Integer total,
        Long esperandoMs,
        Integer intento,
        String mensaje
) {
    public enum Estado {
        STARTED,
        PROGRESS,
        COMPLETED,
        CANCELLED,
        FAILED,
        RATE_LIMITED
    }

    public static SyncEvent started(Instant at) {
        return new SyncEvent(Estado.STARTED, at, null, null, null, null, null);
    }

    public static SyncEvent progress(Instant at, int items, int total) {
        return new SyncEvent(Estado.PROGRESS, at, items, total, null, null, null);
    }

    public static SyncEvent completed(Instant at, int items) {
        return new SyncEvent(Estado.COMPLETED, at, items, items, null, null, null);
    }

    public static SyncEvent cancelled(Instant at, int items) {
        return new SyncEvent(Estado.CANCELLED, at, items, items, null, null, null);
    }

    public static SyncEvent failed(Instant at, String mensaje) {
        return new SyncEvent(Estado.FAILED, at, null, null, null, null, mensaje);
    }

    public static SyncEvent rateLimited(Instant at, long esperandoMs, int intento) {
        return new SyncEvent(Estado.RATE_LIMITED, at, null, null, esperandoMs, intento, null);
    }
}
