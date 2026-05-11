package ar.com.leo.showroom.dux;

import org.junit.jupiter.api.Test;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Tests del {@link PriorityRateLimiter}. Usan un rate "rápido" (10 permits/s =
 * 100ms cada uno) para que el test se mantenga bajo el segundo.
 */
class PriorityRateLimiterTest {

    private static final double FAST_RATE = 10.0;        // 1 permit cada 100ms
    private static final long INTERVAL_MS = 100;

    @Test
    void primer_permit_es_inmediato() throws InterruptedException {
        PriorityRateLimiter limiter = new PriorityRateLimiter(FAST_RATE);

        long start = System.currentTimeMillis();
        limiter.acquire(false);
        long elapsed = System.currentTimeMillis() - start;

        // El primer permit debería tomarse sin espera (rate limiter "frío").
        assertThat(elapsed).isLessThan(20);
    }

    @Test
    void permits_consecutivos_respetan_el_intervalo() throws InterruptedException {
        PriorityRateLimiter limiter = new PriorityRateLimiter(FAST_RATE);

        long start = System.currentTimeMillis();
        for (int i = 0; i < 4; i++) {
            limiter.acquire(false);
        }
        long elapsed = System.currentTimeMillis() - start;

        // 4 permits con interval=100ms → el primero instantáneo, los siguientes a
        // t=100, t=200, t=300. Tolerancia generosa para el scheduler del SO.
        assertThat(elapsed).isBetween(280L, 500L);
    }

    @Test
    void high_priority_se_atiende_antes_que_low_esperando() throws InterruptedException {
        PriorityRateLimiter limiter = new PriorityRateLimiter(FAST_RATE);

        // Quemar el primer permit gratis: ahora todos los próximos esperan ~100ms.
        limiter.acquire(false);

        AtomicLong lowFinishedAt = new AtomicLong();
        AtomicLong highFinishedAt = new AtomicLong();
        CountDownLatch done = new CountDownLatch(2);

        // LOW arranca primero, queda esperando.
        Thread low = new Thread(() -> {
            try {
                limiter.acquire(false);
                lowFinishedAt.set(System.currentTimeMillis());
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            } finally {
                done.countDown();
            }
        });
        low.start();

        // Esperar un toque a que el LOW efectivamente esté blocked en awaitNanos.
        Thread.sleep(20);

        // HIGH llega DESPUÉS pero debería tomar el próximo slot antes que LOW.
        Thread high = new Thread(() -> {
            try {
                limiter.acquire(true);
                highFinishedAt.set(System.currentTimeMillis());
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            } finally {
                done.countDown();
            }
        });
        high.start();

        assertThat(done.await(2, TimeUnit.SECONDS)).isTrue();

        // El HIGH debe haber terminado antes que el LOW, aunque el LOW arrancó primero.
        assertThat(highFinishedAt.get())
                .as("HIGH debe tomar el slot antes que el LOW que ya estaba esperando")
                .isLessThan(lowFinishedAt.get());

        // Y el LOW termina aproximadamente un intervalo después del HIGH.
        long delta = lowFinishedAt.get() - highFinishedAt.get();
        assertThat(delta).isBetween(70L, 200L);
    }

    @Test
    void try_acquire_respeta_timeout() throws InterruptedException {
        PriorityRateLimiter limiter = new PriorityRateLimiter(FAST_RATE);
        limiter.acquire(false); // quemar el primero

        long start = System.currentTimeMillis();
        boolean ok = limiter.tryAcquire(false, 50, TimeUnit.MILLISECONDS);
        long elapsed = System.currentTimeMillis() - start;

        // 50ms timeout < 100ms hasta el próximo slot → debe devolver false sin tomar.
        assertThat(ok).isFalse();
        assertThat(elapsed).isBetween(40L, 120L);
    }

    @Test
    void try_acquire_obtiene_cuando_alcanza_el_tiempo() throws InterruptedException {
        PriorityRateLimiter limiter = new PriorityRateLimiter(FAST_RATE);
        limiter.acquire(false); // quemar el primero

        boolean ok = limiter.tryAcquire(false, 500, TimeUnit.MILLISECONDS);

        assertThat(ok).isTrue();
    }
}
