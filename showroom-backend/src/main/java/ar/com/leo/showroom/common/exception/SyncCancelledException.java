package ar.com.leo.showroom.common.exception;

/**
 * Señaliza cancelación cooperativa durante una operación que puede tardar
 * (típicamente la paginación del sync de catálogo o el sleep entre reintentos
 * post-429). El caller la atrapa y rompe el loop devolviendo los resultados
 * parciales que ya tuviera. No es un error — no propagar al GlobalExceptionHandler.
 */
public class SyncCancelledException extends RuntimeException {
    public SyncCancelledException() {
        super("Sync cancelado por el operador");
    }
}
