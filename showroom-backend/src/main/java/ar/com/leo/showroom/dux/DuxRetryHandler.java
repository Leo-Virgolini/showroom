package ar.com.leo.showroom.dux;

import ar.com.leo.showroom.common.exception.SyncCancelledException;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.web.client.HttpClientErrorException;
import org.springframework.web.client.HttpServerErrorException;
import org.springframework.web.client.ResourceAccessException;
import org.springframework.web.client.RestClient;

import java.util.concurrent.TimeUnit;
import java.util.concurrent.ThreadLocalRandom;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;

/**
 * Reintentos + rate limiting para llamadas a DUX.
 *
 * <ul>
 *   <li>Rate limit local con {@link PriorityRateLimiter} (1 req/7s por default)
 *       para evitar 429 desde el cliente. Las llamadas HIGH (scan ad-hoc, pedido)
 *       se reservan el próximo slot antes que cualquier LOW (sync) encolada —
 *       así un pedido nunca espera la cola completa del sync.</li>
 *   <li>Si DUX igual responde 429, hace hasta 10 reintentos con backoff exponencial + jitter.</li>
 *   <li>Respeta el header Retry-After si DUX lo manda (tiene prioridad sobre el backoff calculado).</li>
 *   <li>5xx y errores de red: 3 reintentos con backoff exponencial.</li>
 *   <li>Si el rate limit persiste varios reintentos consecutivos, notifica vía un callback
 *       opcional (consumido por SyncEventService → SSE → banner global del frontend).</li>
 * </ul>
 */
@Slf4j
public class DuxRetryHandler {

    private static final int MAX_RETRIES = 3;
    private static final int MAX_RETRIES_RATE_LIMIT = 10;
    private static final int RATE_LIMIT_NOTIFY_THRESHOLD = 3;
    private static final long MAX_WAIT_MS = 300_000;
    private static final long CONFLICT_BASE_WAIT_MS = 2000;

    private final RestClient restClient;
    private final long baseWaitMs;
    private final PriorityRateLimiter rateLimiter;
    private final RateLimitListener onRateLimited;

    public DuxRetryHandler(RestClient restClient, long baseWaitMs, double permitsPerSecond) {
        this(restClient, baseWaitMs, permitsPerSecond, null);
    }

    public DuxRetryHandler(RestClient restClient, long baseWaitMs, double permitsPerSecond,
                           RateLimitListener onRateLimited) {
        this.restClient = restClient;
        this.baseWaitMs = baseWaitMs;
        this.rateLimiter = new PriorityRateLimiter(permitsPerSecond);
        this.onRateLimited = onRateLimited;
    }

    public <T> T get(String uri, String token, Class<T> responseType) {
        return get(uri, token, responseType, null, false);
    }

    /**
     * Variante con cancelación cooperativa: si {@code isCancelled} retorna true
     * en cualquier punto del flow (esperar rate limit, esperar entre reintentos),
     * lanza {@link SyncCancelledException}. Sin esto, un 429 puede mantener al
     * thread bloqueado hasta ~17 min en backoff y 10 reintentos sin atender el cancel.
     */
    public <T> T get(String uri, String token, Class<T> responseType, BooleanSupplier isCancelled) {
        return get(uri, token, responseType, isCancelled, false);
    }

    /**
     * Variante con prioridad — {@code highPriority=true} para scans del operador
     * y creación de pedido. Esas llamadas se atienden antes que el sync de catálogo
     * que pueda estar consumiendo permits del rate limiter.
     */
    public <T> T get(String uri, String token, Class<T> responseType,
                     BooleanSupplier isCancelled, boolean highPriority) {
        return executeWithRetries("GET", isCancelled, highPriority, () -> restClient.get()
                .uri(uri)
                .header("authorization", token)
                .retrieve()
                .body(responseType));
    }

    public String postJson(String uri, String token, String jsonBody) {
        return postJson(uri, token, jsonBody, null, false);
    }

    /** Variante con cancelación cooperativa — ver {@link #get(String, String, Class, BooleanSupplier)}. */
    public String postJson(String uri, String token, String jsonBody, BooleanSupplier isCancelled) {
        return postJson(uri, token, jsonBody, isCancelled, false);
    }

    /** Variante con prioridad — usar {@code highPriority=true} para POST /pedido/nuevopedido. */
    public String postJson(String uri, String token, String jsonBody,
                           BooleanSupplier isCancelled, boolean highPriority) {
        return executeWithRetries("POST", isCancelled, highPriority, () -> restClient.post()
                .uri(uri)
                .header("authorization", token)
                .contentType(MediaType.APPLICATION_JSON)
                .body(jsonBody)
                .retrieve()
                .body(String.class));
    }

    private <T> T executeWithRetries(String op, BooleanSupplier isCancelled,
                                     boolean highPriority, Supplier<T> call) {
        int normalRetries = 0;
        int rateLimitRetries = 0;
        while (true) {
            checkCancelled(isCancelled);
            try {
                acquireRateLimit(isCancelled, highPriority);
                return call.get();
            } catch (HttpClientErrorException e) {
                int status = e.getStatusCode().value();
                if (status == 401) {
                    log.error("DUX 401 en {} - token inválido/expirado", op);
                    throw e;
                }
                if (status == 429) {
                    if (++rateLimitRetries > MAX_RETRIES_RATE_LIMIT) throw e;
                    long w = calcular429(e.getResponseHeaders(), rateLimitRetries);
                    log.warn("DUX 429 en {} - retry en {}s ({}/{})", op, w / 1000, rateLimitRetries, MAX_RETRIES_RATE_LIMIT);
                    notificarSiCorresponde(rateLimitRetries, w, op);
                    sleepCancellable(w, isCancelled);
                    continue;
                }
                if (status == 409 || status == 423) {
                    if (++normalRetries >= MAX_RETRIES) throw e;
                    sleepCancellable(CONFLICT_BASE_WAIT_MS + ThreadLocalRandom.current().nextInt(500, 1500), isCancelled);
                    continue;
                }
                throw e;
            } catch (HttpServerErrorException | ResourceAccessException e) {
                if (++normalRetries >= MAX_RETRIES) throw e;
                sleepCancellable(baseWaitMs * (long) Math.pow(2, normalRetries - 1), isCancelled);
            }
        }
    }

    private void checkCancelled(BooleanSupplier isCancelled) {
        if (isCancelled != null && isCancelled.getAsBoolean()) {
            throw new SyncCancelledException();
        }
    }

    /**
     * Adquiere un permit del rate limiter con la prioridad indicada, chequeando
     * cancelación periódicamente. Sin supplier, espera bloqueado hasta tenerlo.
     * Con supplier, intenta cada 500ms y revisa el flag entre intentos — la
     * cancelación se hace efectiva en hasta 500ms.
     */
    private void acquireRateLimit(BooleanSupplier isCancelled, boolean highPriority) {
        try {
            if (isCancelled == null) {
                rateLimiter.acquire(highPriority);
                return;
            }
            while (!rateLimiter.tryAcquire(highPriority, 500, TimeUnit.MILLISECONDS)) {
                checkCancelled(isCancelled);
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new RuntimeException("Interrumpido esperando rate limit DUX", e);
        }
    }

    /**
     * Sleep partido en chunks de 500ms con check de cancelación entre cada uno.
     * Sin supplier, llama al sleep tradicional. Esto evita que un wait de 5 min
     * post-429 ignore el cancel — la cancelación toma efecto en hasta 500ms.
     */
    private void sleepCancellable(long ms, BooleanSupplier isCancelled) {
        if (isCancelled == null) {
            sleep(ms);
            return;
        }
        long deadline = System.currentTimeMillis() + ms;
        while (true) {
            checkCancelled(isCancelled);
            long remaining = deadline - System.currentTimeMillis();
            if (remaining <= 0) return;
            sleep(Math.min(remaining, 500));
        }
    }

    /**
     * Wait time para 429: prioriza header Retry-After. Si DUX no lo manda, usa
     * backoff exponencial con jitter: 2^n × 1000ms + random(0..1000ms), capped.
     */
    private long calcular429(HttpHeaders headers, int intento) {
        long fromHeader = parseRetryAfter(headers);
        if (fromHeader > 0) return Math.min(fromHeader, MAX_WAIT_MS);
        long expo = (long) Math.pow(2, intento) * 1000L;
        long jitter = ThreadLocalRandom.current().nextLong(0, 1000);
        return Math.min(expo + jitter, MAX_WAIT_MS);
    }

    private void notificarSiCorresponde(int intento, long esperandoMs, String op) {
        if (onRateLimited != null && intento >= RATE_LIMIT_NOTIFY_THRESHOLD) {
            try {
                onRateLimited.onRateLimit(intento, esperandoMs, op);
            } catch (Exception ex) {
                log.warn("Error notificando rate limit: {}", ex.getMessage());
            }
        }
    }

    private long parseRetryAfter(HttpHeaders headers) {
        if (headers == null) return 0;
        String h = headers.getFirst("Retry-After");
        if (h == null) return 0;
        try {
            return Long.parseLong(h) * 1000;
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    private void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    @FunctionalInterface
    public interface RateLimitListener {
        /**
         * @param op {@code "GET"} o {@code "POST"} — permite al listener decidir
         *           si propagar el evento al SSE. Solo el sync de catálogo (GETs
         *           paginados) debería disparar el banner global; un POST de pedido
         *           con 429 es ruido para los demás operadores.
         */
        void onRateLimit(int intentosConsecutivos, long esperandoMs, String op);
    }
}
