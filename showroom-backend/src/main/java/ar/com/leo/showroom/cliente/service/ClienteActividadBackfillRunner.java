package ar.com.leo.showroom.cliente.service;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.stereotype.Component;

/**
 * Dispara el {@link ClienteActividadBackfillService} una vez al terminar el
 * arranque. Es un bean aparte (no transaccional) para que la llamada a
 * {@code ejecutar()} pase por el proxy de Spring y respete su {@code @Transactional}.
 * El backfill es idempotente, así que correrlo en cada arranque es seguro: tras
 * el primero no hay nada pendiente y termina enseguida.
 */
@Component
@Slf4j
@RequiredArgsConstructor
public class ClienteActividadBackfillRunner implements ApplicationRunner {

    private final ClienteActividadBackfillService backfillService;

    @Override
    public void run(ApplicationArguments args) {
        try {
            backfillService.ejecutar();
        } catch (Exception e) {
            // Un fallo del backfill no debe impedir que la app levante: la vista
            // /clientes seguiría mostrando datos parcialmente materializados y el
            // próximo arranque reintenta (es idempotente).
            log.error("Falló el backfill de actividad de clientes: {}", e.getMessage(), e);
        }
    }
}
