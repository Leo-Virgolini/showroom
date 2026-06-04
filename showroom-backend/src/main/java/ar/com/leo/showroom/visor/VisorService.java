package ar.com.leo.showroom.visor;

import ar.com.leo.showroom.events.SyncEventService;
import ar.com.leo.showroom.showroom.dto.ScanResultDTO;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

/**
 * Publica al "visor" — pantalla espejo de lectura, pensada para que un cliente
 * la mire desde el celular mientras el operador escanea productos en la
 * pantalla principal del showroom.
 *
 * <p>Cada operador tiene su propio canal de visor. Los celulares se conectan a
 * {@code /visor/{username}} y reciben solo los scans del operador
 * correspondiente — sin esto, todos los celulares verían los scans de todos
 * los operadores mezclados.
 *
 * <p>Los eventos se publican vía {@link SyncEventService#publishTo} sobre el
 * username del operador propietario. El servicio no mantiene estado: si un
 * visor se conecta tarde, queda esperando hasta que ocurra el próximo scan
 * (decisión intencional — la idea es que muestre lo que el operador está
 * mirando ahora, no lo último que pasó hace rato).
 *
 * <p>Los "agregar al carrito" disparados desde el visor pasan por
 * {@code CarritoService} y se reflejan via SSE {@code carrito-updated} en
 * el canal del operador.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class VisorService {

    public static final String EVENTO_SCAN = "scan-visor";
    public static final String EVENTO_SCAN_ERROR = "scan-visor-error";
    public static final String EVENTO_FORMA = "visor-forma";

    private final SyncEventService eventService;

    /** Llamado desde el controller después de cada scan exitoso. {@code username}
     *  es el operador que disparó el scan — el evento solo le llega a los
     *  visores ligados a ese operador. Si {@code username} es null/blank, no
     *  se publica (típicamente porque el scan se hizo desde un endpoint sin
     *  auth resuelta). */
    public void publicarScan(String username, ScanResultDTO scan) {
        if (scan == null) return;
        eventService.publishTo(username, EVENTO_SCAN, scan);
    }

    /**
     * Publica al visor del operador que su scan no encontró el producto
     * (404 en {@code /scan/{sku}}). El visor lo recibe vía SSE
     * {@code scan-visor-error} y muestra un mensaje claro al cliente para que
     * no se confunda con el último producto válido que sigue en pantalla.
     */
    public void publicarScanFallido(String username, String codigo) {
        if (codigo == null || codigo.isBlank()) return;
        eventService.publishTo(username, EVENTO_SCAN_ERROR,
                java.util.Map.of("codigo", codigo));
    }

    /**
     * Publica al visor del operador la forma de pago elegida en el scan, para
     * que la pantalla del cliente muestre el precio con esa misma forma. El
     * payload es {@code {formaId}} y el visor mantiene el último valor recibido
     * (sticky). Si {@code username} es null/blank no se publica (scan
     * silencioso / sin auth resuelta).
     */
    public void publicarForma(String username, Long formaId) {
        if (username == null || username.isBlank() || formaId == null) return;
        eventService.publishTo(username, EVENTO_FORMA,
                java.util.Map.of("formaId", formaId));
    }
}
