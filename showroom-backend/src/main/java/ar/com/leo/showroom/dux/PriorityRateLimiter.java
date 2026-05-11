package ar.com.leo.showroom.dux;

import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.Condition;
import java.util.concurrent.locks.ReentrantLock;

/**
 * Rate limiter con dos niveles de prioridad. La prioridad alta (HIGH) siempre
 * adquiere el próximo permit antes que cualquier baja (LOW) encolada, aunque
 * la LOW haya llegado primero y ya esté esperando.
 *
 * <p>Uso típico en el showroom:
 * <ul>
 *   <li><b>HIGH</b> — operaciones del operador con latencia visible: scan
 *       ad-hoc de un SKU desconocido, creación de pedido.</li>
 *   <li><b>LOW</b> — operaciones background sin urgencia: sync periódico del
 *       catálogo (~120 requests, ~15 min), descarga de provincias/localidades.</li>
 * </ul>
 *
 * <p>Garantías:
 * <ul>
 *   <li>Se emite a lo sumo 1 permit cada {@code intervalNanos}.</li>
 *   <li>Un HIGH waiting siempre se atiende antes que un LOW waiting cuando
 *       el próximo slot está disponible — incluso si el LOW estaba bloqueado
 *       desde antes.</li>
 *   <li>Sin HIGH waiting, el LOW recibe el slot normal — el throughput total
 *       del sync no se degrada cuando no hay actividad del operador.</li>
 * </ul>
 *
 * <p>Implementación: un timestamp {@code nextPermitAtNanos} (instant absoluto
 * del próximo slot disponible) y dos {@link Condition} separadas. El LOW
 * cede ante la presencia de cualquier HIGH waiting. El HIGH despierta a un
 * LOW cuando termina, por si reabre el slot.
 */
public class PriorityRateLimiter {

    private final long intervalNanos;
    private final ReentrantLock lock = new ReentrantLock(true);
    private final Condition highCondition = lock.newCondition();
    private final Condition lowCondition = lock.newCondition();

    private int highWaiters = 0;
    /** Instant (System.nanoTime) en el que el próximo permit estará disponible. */
    private long nextPermitAtNanos;

    public PriorityRateLimiter(double permitsPerSecond) {
        if (permitsPerSecond <= 0) {
            throw new IllegalArgumentException("permitsPerSecond debe ser > 0");
        }
        this.intervalNanos = (long) (1_000_000_000L / permitsPerSecond);
        this.nextPermitAtNanos = System.nanoTime();
    }

    /** Bloquea hasta obtener un permit del nivel pedido. */
    public void acquire(boolean highPriority) throws InterruptedException {
        if (highPriority) {
            acquireHigh(Long.MAX_VALUE);
        } else {
            acquireLow(Long.MAX_VALUE);
        }
    }

    /**
     * Intenta obtener un permit dentro del timeout dado. Devuelve {@code true}
     * si lo obtuvo, {@code false} si venció antes. Usado por el retry handler
     * para hacer polling de cancelación entre intentos cortos.
     */
    public boolean tryAcquire(boolean highPriority, long timeout, TimeUnit unit) throws InterruptedException {
        long deadlineNanos = System.nanoTime() + unit.toNanos(timeout);
        if (highPriority) {
            return acquireHigh(deadlineNanos);
        }
        return acquireLow(deadlineNanos);
    }

    private boolean acquireHigh(long deadlineNanos) throws InterruptedException {
        lock.lock();
        try {
            highWaiters++;
            try {
                while (true) {
                    long now = System.nanoTime();
                    long wait = nextPermitAtNanos - now;
                    if (wait <= 0) {
                        nextPermitAtNanos = now + intervalNanos;
                        return true;
                    }
                    long remaining = deadlineNanos - now;
                    if (remaining <= 0) return false;
                    highCondition.awaitNanos(Math.min(wait, remaining));
                }
            } finally {
                highWaiters--;
                // Si fui el último HIGH waiting, despertar a todos los LOW para que
                // re-evalúen — antes estaban bloqueados por mi presencia.
                if (highWaiters == 0) {
                    lowCondition.signalAll();
                }
            }
        } finally {
            lock.unlock();
        }
    }

    private boolean acquireLow(long deadlineNanos) throws InterruptedException {
        lock.lock();
        try {
            while (true) {
                long now = System.nanoTime();
                long remaining = deadlineNanos - now;
                if (remaining <= 0) return false;

                // Mientras haya HIGH esperando, el LOW cede el turno entero.
                if (highWaiters > 0) {
                    lowCondition.awaitNanos(remaining);
                    continue;
                }

                long wait = nextPermitAtNanos - now;
                if (wait <= 0) {
                    nextPermitAtNanos = now + intervalNanos;
                    return true;
                }
                lowCondition.awaitNanos(Math.min(wait, remaining));
            }
        } finally {
            lock.unlock();
        }
    }
}
