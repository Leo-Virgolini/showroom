package ar.com.leo.showroom.visor;

import ar.com.leo.showroom.events.SyncEventService;
import ar.com.leo.showroom.showroom.dto.ScanResultDTO;
import ar.com.leo.showroom.showroom.dto.VisorAgregarCarritoEventDTO;
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
 * <p>Adicionalmente, cuando el cliente toca "Agregar al carrito" en el visor,
 * el backend valida y emite {@code visor-add-cart} para que la pantalla del
 * operador sume el item al carrito en vivo.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class VisorService {

    public static final String EVENTO_SCAN = "scan-visor";
    public static final String EVENTO_ADD_CART = "visor-add-cart";

    private final SyncEventService eventService;

    /** Llamado desde el controller después de cada scan exitoso. */
    public void publicarScan(ScanResultDTO scan) {
        if (scan == null) return;
        eventService.publish(EVENTO_SCAN, scan);
    }

    /**
     * Llamado después de validar un "agregar al carrito" disparado desde el
     * visor. La pantalla del operador escucha este evento y suma el item.
     */
    public void publicarAddToCart(ScanResultDTO scan, int cantidad) {
        if (scan == null) return;
        eventService.publish(EVENTO_ADD_CART, new VisorAgregarCarritoEventDTO(scan, cantidad));
    }
}
