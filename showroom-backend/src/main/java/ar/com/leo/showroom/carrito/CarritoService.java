package ar.com.leo.showroom.carrito;

import ar.com.leo.showroom.catalogo.entity.ProductoCache;
import ar.com.leo.showroom.catalogo.service.CatalogoSyncService;
import ar.com.leo.showroom.common.exception.ConflictException;
import ar.com.leo.showroom.common.exception.NotFoundException;
import ar.com.leo.showroom.events.SyncEventService;
import ar.com.leo.showroom.showroom.dto.CarritoAgregarResponseDTO;
import ar.com.leo.showroom.showroom.dto.CarritoItemDTO;
import ar.com.leo.showroom.showroom.dto.CarritoStateDTO;
import ar.com.leo.showroom.showroom.dto.ScanResultDTO;
import ar.com.leo.showroom.showroom.service.ShowroomService;
import lombok.extern.slf4j.Slf4j;
import org.springframework.context.annotation.Lazy;
import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.locks.ReentrantLock;

/**
 * Estado del carrito del showroom — único, global, en memoria. Cualquier
 * pantalla logueada (operador en {@code /}) o pública ({@code /visor}) opera
 * sobre el mismo carrito y todas las pantallas suscritas al SSE
 * {@code carrito-updated} se sincronizan al instante.
 *
 * <p><b>Por qué carrito único global:</b> el showroom atiende un cliente a la
 * vez, así que no tiene sentido tener carritos por sesión. Si en el futuro
 * se necesita atender en paralelo (caja A y caja B), se cambia a
 * {@code Map<userId, CarritoState>} sin tocar los callers.
 *
 * <p><b>Persistencia:</b> ninguna. Restart del backend ⇒ carrito vacío.
 * Aceptable porque el carrito es ephemeral (vida útil ~minutos).
 *
 * <p><b>Concurrencia:</b> todas las mutaciones bajo un {@link ReentrantLock}
 * porque el estado se toca desde requests HTTP simultáneos del operador y del
 * visor. El cost es despreciable (carritos < 100 items).
 */
@Slf4j
@Service
public class CarritoService {

    public static final String EVENTO_CARRITO = "carrito-updated";

    private final CatalogoSyncService catalogoSync;
    private final ShowroomService showroomService;
    private final SyncEventService eventService;

    private final ReentrantLock lock = new ReentrantLock();
    private final Map<String, CarritoItemDTO> items = new LinkedHashMap<>();

    /** @Lazy en ShowroomService evita potencial ciclo si en el futuro algún
     *  service usado por ShowroomService termina tocando CarritoService. */
    public CarritoService(
            CatalogoSyncService catalogoSync,
            @Lazy ShowroomService showroomService,
            SyncEventService eventService) {
        this.catalogoSync = catalogoSync;
        this.showroomService = showroomService;
        this.eventService = eventService;
    }

    public CarritoStateDTO obtener() {
        lock.lock();
        try {
            return snapshot(CarritoStateDTO.Origen.SISTEMA);
        } finally {
            lock.unlock();
        }
    }

    /**
     * Agrega {@code cantidad} unidades del producto con {@code sku} al carrito.
     * Si el item ya existe, suma a lo que había. Si el total supera el stock,
     * recorta y reporta cuánto se sumó realmente.
     *
     * @throws NotFoundException si el SKU no está en cache (no se llama a DUX).
     * @throws ConflictException si está deshabilitado o no tiene precio.
     */
    public CarritoAgregarResponseDTO agregar(String sku, int cantidad, CarritoStateDTO.Origen origen) {
        if (sku == null || sku.isBlank()) {
            throw new NotFoundException("SKU vacío");
        }
        if (cantidad <= 0) {
            throw new ConflictException("La cantidad debe ser mayor a 0");
        }
        ProductoCache pc = catalogoSync.buscarPorSkuOEan(sku.trim())
                .orElseThrow(() -> new NotFoundException("Producto no encontrado: " + sku));
        if (Boolean.FALSE.equals(pc.getHabilitado())) {
            throw new ConflictException("El producto está deshabilitado");
        }
        BigDecimal precio = pc.getPvpKtGastroConIva();
        if (precio == null || precio.signum() <= 0) {
            throw new ConflictException("El producto no tiene precio cargado en la lista KT GASTRO");
        }

        ScanResultDTO scan = showroomService.toScanResult(pc);
        Integer stock = scan.stockTotal();

        lock.lock();
        try {
            CarritoItemDTO actual = items.get(scan.sku());
            int cantidadActual = actual != null ? actual.cantidad() : 0;
            int cantidadDeseada = cantidadActual + cantidad;
            int cantidadFinal = (stock != null && stock >= 0)
                    ? Math.min(cantidadDeseada, stock)
                    : cantidadDeseada;
            int agregada = cantidadFinal - cantidadActual;
            boolean recortado = cantidadFinal < cantidadDeseada;

            if (cantidadFinal <= 0) {
                // Sin stock disponible — no agregamos nada.
                String motivo = stock != null && stock <= 0
                        ? "El producto no tiene stock disponible"
                        : "Cantidad inválida";
                return new CarritoAgregarResponseDTO(
                        snapshot(origen), cantidad, 0, true, motivo);
            }

            if (actual == null) {
                items.put(scan.sku(), CarritoItemDTO.from(scan, cantidadFinal));
            } else {
                items.put(scan.sku(), actual
                        .conScanActualizado(scan)
                        .withCantidad(cantidadFinal));
            }

            CarritoStateDTO state = snapshot(origen);
            broadcast(state);
            String motivo = recortado
                    ? "Recortado al stock disponible (" + stock + ")"
                    : null;
            return new CarritoAgregarResponseDTO(
                    state, cantidad, agregada, recortado, motivo);
        } finally {
            lock.unlock();
        }
    }

    /** Reemplaza la cantidad de un item existente. Si la nueva cantidad supera
     *  el stock, se recorta. */
    public CarritoStateDTO actualizarCantidad(String sku, int cantidad) {
        if (cantidad <= 0) {
            throw new ConflictException("La cantidad debe ser mayor a 0");
        }
        lock.lock();
        try {
            CarritoItemDTO actual = items.get(sku);
            if (actual == null) {
                throw new NotFoundException("El item no está en el carrito: " + sku);
            }
            Integer stock = actual.stockTotal();
            int cantidadFinal = (stock != null && stock >= 0) ? Math.min(cantidad, stock) : cantidad;
            items.put(sku, actual.withCantidad(cantidadFinal));
            CarritoStateDTO state = snapshot(CarritoStateDTO.Origen.OPERADOR);
            broadcast(state);
            return state;
        } finally {
            lock.unlock();
        }
    }

    public CarritoStateDTO eliminar(String sku) {
        lock.lock();
        try {
            if (items.remove(sku) == null) {
                throw new NotFoundException("El item no está en el carrito: " + sku);
            }
            CarritoStateDTO state = snapshot(CarritoStateDTO.Origen.OPERADOR);
            broadcast(state);
            return state;
        } finally {
            lock.unlock();
        }
    }

    public CarritoStateDTO vaciar(CarritoStateDTO.Origen origen) {
        lock.lock();
        try {
            items.clear();
            CarritoStateDTO state = snapshot(origen);
            broadcast(state);
            return state;
        } finally {
            lock.unlock();
        }
    }

    /**
     * Refresca contra DUX el stock de todos los items del carrito. <b>No
     * toca los precios</b>: el cliente paga lo que vio al armar el pedido,
     * aunque DUX haya cambiado el precio entre el scan y el envío. Sí se
     * actualizan stock, descripción, imagen, habilitado y flags de
     * sincronización porque son metadata que el operador debe ver.
     *
     * <p>Si DUX recorta el stock por debajo de la cantidad pedida en algún
     * item, el frontend lo verá al recibir el SSE — la decisión de qué hacer
     * (recortar o mantener) la sigue tomando el operador en pantalla.
     */
    public CarritoStateDTO refrescarStock() {
        List<String> skus;
        lock.lock();
        try {
            skus = new ArrayList<>(items.keySet());
        } finally {
            lock.unlock();
        }
        if (skus.isEmpty()) {
            return obtener();
        }

        // FUERA del lock: cada SKU consume 1 request DUX (~7s). No podemos
        // tener el lock tomado mientras esperamos a la red.
        List<ProductoCache> frescos = catalogoSync.refrescarSkus(skus);
        Map<String, ScanResultDTO> map = new LinkedHashMap<>();
        for (ProductoCache pc : frescos) {
            map.put(pc.getSku(), showroomService.toScanResult(pc));
        }

        lock.lock();
        try {
            for (Map.Entry<String, CarritoItemDTO> e : items.entrySet()) {
                ScanResultDTO fresh = map.get(e.getKey());
                if (fresh != null) {
                    items.put(e.getKey(), e.getValue().withStockFrescoDe(fresh));
                }
            }
            CarritoStateDTO state = snapshot(CarritoStateDTO.Origen.OPERADOR);
            broadcast(state);
            return state;
        } finally {
            lock.unlock();
        }
    }

    /** Lectura inmutable del estado actual. El caller ya debe tener el lock. */
    private CarritoStateDTO snapshot(CarritoStateDTO.Origen origen) {
        return CarritoStateDTO.of(new ArrayList<>(items.values()), origen);
    }

    private void broadcast(CarritoStateDTO state) {
        eventService.publish(EVENTO_CARRITO, state);
    }
}
