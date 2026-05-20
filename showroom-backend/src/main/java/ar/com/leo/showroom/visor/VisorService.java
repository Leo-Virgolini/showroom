package ar.com.leo.showroom.visor;

import ar.com.leo.showroom.events.SyncEventService;
import ar.com.leo.showroom.showroom.dto.ScanResultDTO;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

/**
 * Publica al "visor" — pantalla de sólo lectura, pensada para que un cliente
 * la mire desde el celular mientras el operador escanea productos en la
 * pantalla principal del showroom.
 *
 * <p>Cada scan exitoso se publica como evento SSE {@code scan-visor} sobre el
 * bus existente {@link SyncEventService}. El servicio no mantiene estado: si
 * un visor se conecta tarde, queda esperando hasta que ocurra el próximo
 * scan (decisión intencional — la idea es que muestre lo que el operador
 * está mirando ahora, no lo último que pasó hace rato).
 *
 * <p>Los "agregar al carrito" disparados desde el visor pasan por
 * {@code CarritoService} y se reflejan via SSE {@code carrito-updated}.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class VisorService {

    public static final String EVENTO_SCAN = "scan-visor";
    public static final String EVENTO_SCAN_ERROR = "scan-visor-error";

    private final SyncEventService eventService;

    /** Llamado desde el controller después de cada scan exitoso. */
    public void publicarScan(ScanResultDTO scan) {
        if (scan == null) return;
        eventService.publish(EVENTO_SCAN, scan);
    }

    /**
     * Publica al visor que el operador intentó escanear un código que no
     * existe (404 en {@code /scan/{sku}}). El visor lo recibe vía SSE
     * {@code scan-visor-error} y muestra un mensaje claro al cliente para
     * que no se confunda con el último producto válido que sigue en pantalla.
     */
    public void publicarScanFallido(String codigo) {
        if (codigo == null || codigo.isBlank()) return;
        eventService.publish(EVENTO_SCAN_ERROR,
                java.util.Map.of("codigo", codigo));
    }
}
