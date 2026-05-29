package ar.com.leo.showroom.carrito;

import ar.com.leo.showroom.catalogo.entity.ProductoCache;
import ar.com.leo.showroom.catalogo.service.CatalogoSyncService;
import ar.com.leo.showroom.common.exception.ConflictException;
import ar.com.leo.showroom.common.exception.NotFoundException;
import ar.com.leo.showroom.dux.config.DuxProperties;
import ar.com.leo.showroom.events.SesionCerradaEvent;
import ar.com.leo.showroom.events.SyncCatalogoCompletadoEvent;
import ar.com.leo.showroom.events.SyncEventService;
import ar.com.leo.showroom.showroom.dto.CarritoAgregarResponseDTO;
import ar.com.leo.showroom.showroom.dto.CarritoItemDTO;
import ar.com.leo.showroom.showroom.dto.CarritoStateDTO;
import ar.com.leo.showroom.showroom.dto.ScanResultDTO;
import ar.com.leo.showroom.showroom.service.ShowroomService;
import lombok.extern.slf4j.Slf4j;
import org.springframework.context.annotation.Lazy;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.locks.ReentrantLock;

/**
 * Estado del carrito del showroom — un carrito independiente por usuario logueado.
 * Cada operador tiene su propio carrito (identificado por username); ni el
 * operador A ve el de B ni se contaminan entre sí. El visor del cliente
 * (pantalla espejo en celular) se liga al canal de un operador específico
 * vía {@code /visor/{username}} y opera sobre el carrito de ese operador.
 *
 * <p><b>Persistencia:</b> ninguna. Restart del backend ⇒ todos los carritos
 * vacíos. Aceptable porque el carrito es ephemeral (vida útil ~minutos).
 *
 * <p><b>Concurrencia:</b> {@link ConcurrentHashMap} de "espacios" por usuario;
 * dentro de cada espacio, un {@link ReentrantLock} protege las mutaciones del
 * carrito de ese usuario. Operadores distintos no compiten por el mismo lock
 * — un carrito ocupado en refrescar stock (~7s por SKU) no bloquea al resto.
 *
 * <p>Los eventos {@code carrito-updated} se publican al canal del usuario
 * propietario, así que cada pantalla solo recibe su propio carrito.
 */
@Slf4j
@Service
public class CarritoService {

    public static final String EVENTO_CARRITO = "carrito-updated";

    private final CatalogoSyncService catalogoSync;
    private final ShowroomService showroomService;
    private final SyncEventService eventService;
    private final DuxProperties duxProperties;

    /** Carrito por usuario. {@code computeIfAbsent} crea el espacio al primer
     *  acceso; nunca se elimina (sobrevive a logout — el operador encuentra
     *  su carrito tal cual lo dejó al volver a entrar). */
    private final Map<String, EspacioUsuario> espacios = new ConcurrentHashMap<>();

    /** @Lazy en ShowroomService evita potencial ciclo si en el futuro algún
     *  service usado por ShowroomService termina tocando CarritoService. */
    public CarritoService(
            CatalogoSyncService catalogoSync,
            @Lazy ShowroomService showroomService,
            SyncEventService eventService,
            DuxProperties duxProperties) {
        this.catalogoSync = catalogoSync;
        this.showroomService = showroomService;
        this.eventService = eventService;
        this.duxProperties = duxProperties;
    }

    public CarritoStateDTO obtener(String username) {
        EspacioUsuario esp = espacioDe(username);
        esp.lock.lock();
        try {
            return snapshot(esp, CarritoStateDTO.Origen.SISTEMA);
        } finally {
            esp.lock.unlock();
        }
    }

    /**
     * Agrega {@code cantidad} unidades del producto al carrito del usuario
     * {@code username}. Si el item ya existe, suma a lo que había. Si el total
     * supera el stock, recorta y reporta cuánto se sumó realmente — salvo que
     * {@code forzar=true}, en cuyo caso se agrega la cantidad pedida ignorando
     * el stock (queda marcado como excedido y el operador lo resuelve antes
     * de generar el pedido en DUX).
     *
     * @throws NotFoundException si el SKU no está en cache (no se llama a DUX).
     * @throws ConflictException si está deshabilitado o no tiene precio.
     */
    public CarritoAgregarResponseDTO agregar(String username, String sku, int cantidad,
                                             CarritoStateDTO.Origen origen, boolean forzar) {
        if (sku == null || sku.isBlank()) {
            throw new NotFoundException("SKU vacío");
        }
        if (cantidad <= 0) {
            throw new ConflictException("La cantidad debe ser mayor a 0");
        }
        // El SKU comodín se agrega solo vía `agregarGenerico` (con descripción
        // + precio del operador). Si llega por la ruta de scan normal, lo
        // rechazamos para no terminar con una línea sin datos útiles.
        if (sku.trim().equals(duxProperties.skuProductoGenerico())) {
            throw new ConflictException(
                    "El SKU " + sku.trim() + " es comodín — cargalo desde \"+ Producto genérico\".");
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

        EspacioUsuario esp = espacioDe(username);
        esp.lock.lock();
        try {
            CarritoItemDTO actual = esp.items.get(scan.sku());
            int cantidadActual = actual != null ? actual.cantidad() : 0;
            int cantidadDeseada = cantidadActual + cantidad;
            // Si forzar=true, ignoramos el stock — el operador asume la
            // responsabilidad de que el item quede "excedido" y lo resuelva
            // antes de crear el pedido en DUX.
            int cantidadFinal = forzar || stock == null || stock < 0
                    ? cantidadDeseada
                    : Math.min(cantidadDeseada, stock);
            int agregada = cantidadFinal - cantidadActual;
            boolean recortado = !forzar && cantidadFinal < cantidadDeseada;

            if (cantidadFinal <= 0) {
                // Sin stock disponible — no agregamos nada.
                String motivo = stock != null && stock <= 0
                        ? "El producto no tiene stock disponible"
                        : "Cantidad inválida";
                return new CarritoAgregarResponseDTO(
                        snapshot(esp, origen), cantidad, 0, true, motivo);
            }

            if (actual == null) {
                esp.items.put(scan.sku(), CarritoItemDTO.from(scan, cantidadFinal));
            } else {
                esp.items.put(scan.sku(), actual
                        .conScanActualizado(scan)
                        .withCantidad(cantidadFinal));
            }

            CarritoStateDTO state = snapshot(esp, origen);
            broadcast(username, state);
            String motivo = recortado
                    ? "Recortado al stock disponible (" + stock + ")"
                    : null;
            return new CarritoAgregarResponseDTO(
                    state, cantidad, agregada, recortado, motivo);
        } finally {
            esp.lock.unlock();
        }
    }

    /** Sobrecarga sin forzar — compatibilidad con callers existentes que
     *  respetan la política de stock por defecto. */
    public CarritoAgregarResponseDTO agregar(String username, String sku, int cantidad,
                                             CarritoStateDTO.Origen origen) {
        return agregar(username, sku, cantidad, origen, false);
    }

    /**
     * Agrega una línea de producto genérico al carrito: el SKU es el comodín
     * configurado en {@code dux.sku-producto-generico} y los demás campos los
     * carga el operador desde el dialog "+ Producto genérico". A diferencia
     * de {@link #agregar}, cada llamada crea una línea NUEVA en el carrito
     * (uid sintético como key) — varias líneas con el mismo SKU comodín
     * pueden convivir, cada una con su propia descripción + precio.
     *
     * <p>No verifica catálogo ni stock — el genérico no existe como producto
     * real; el SKU comodín en DUX no tiene precio ni stock asociado. El
     * operador es responsable de la cantidad y el precio que tipea.
     */
    public CarritoStateDTO agregarGenerico(String username, String descripcion,
                                           BigDecimal precioConIva, BigDecimal porcIva,
                                           int cantidad, boolean maquinaria) {
        if (descripcion == null || descripcion.isBlank()) {
            throw new ConflictException("La descripción es obligatoria para el producto genérico");
        }
        if (precioConIva == null || precioConIva.signum() <= 0) {
            throw new ConflictException("El precio debe ser mayor a 0");
        }
        if (cantidad <= 0) {
            throw new ConflictException("La cantidad debe ser mayor a 0");
        }
        BigDecimal iva = porcIva != null ? porcIva : new BigDecimal("21");
        String skuGenerico = duxProperties.skuProductoGenerico();
        // Si el operador marcó "maquinaria", asignamos rubro MAQUINAS
        // INDUSTRIALES para que la lógica existente de rubroExcluyeDescuentos
        // lo excluya del descuento por escala. Sino queda con rubro null y
        // entra en la escala como cualquier producto.
        String rubro = maquinaria ? "MAQUINAS INDUSTRIALES" : null;
        String itemKey = "gen-" + System.currentTimeMillis() + "-"
                + Long.toHexString(ThreadLocalRandom.current().nextLong() & 0xFFFFFFFFL);
        CarritoItemDTO nuevo = CarritoItemDTO.generico(itemKey, skuGenerico,
                descripcion.trim(), rubro, precioConIva, iva, cantidad);

        EspacioUsuario esp = espacioDe(username);
        esp.lock.lock();
        try {
            esp.items.put(itemKey, nuevo);
            CarritoStateDTO state = snapshot(esp, CarritoStateDTO.Origen.OPERADOR);
            broadcast(username, state);
            return state;
        } finally {
            esp.lock.unlock();
        }
    }

    /** Reemplaza la cantidad de un item existente. Si la nueva cantidad supera
     *  el stock disponible, se respeta la cantidad pedida y el ítem queda
     *  marcado como excedido del lado del frontend — el operador decide si
     *  ajusta o lo manda igual como pendiente de reposición al crear el
     *  pedido en DUX.
     *
     *  <p>{@code itemKey} es la clave única dentro del carrito: el SKU para
     *  items normales, un uid sintético para genéricos. Coincide con
     *  {@link CarritoItemDTO#itemKey()}. */
    public CarritoStateDTO actualizarCantidad(String username, String itemKey, int cantidad) {
        if (cantidad <= 0) {
            throw new ConflictException("La cantidad debe ser mayor a 0");
        }
        EspacioUsuario esp = espacioDe(username);
        esp.lock.lock();
        try {
            CarritoItemDTO actual = esp.items.get(itemKey);
            if (actual == null) {
                throw new NotFoundException("El item no está en el carrito: " + itemKey);
            }
            esp.items.put(itemKey, actual.withCantidad(cantidad));
            CarritoStateDTO state = snapshot(esp, CarritoStateDTO.Origen.OPERADOR);
            broadcast(username, state);
            return state;
        } finally {
            esp.lock.unlock();
        }
    }

    public CarritoStateDTO eliminar(String username, String itemKey) {
        EspacioUsuario esp = espacioDe(username);
        esp.lock.lock();
        try {
            if (esp.items.remove(itemKey) == null) {
                throw new NotFoundException("El item no está en el carrito: " + itemKey);
            }
            CarritoStateDTO state = snapshot(esp, CarritoStateDTO.Origen.OPERADOR);
            broadcast(username, state);
            return state;
        } finally {
            esp.lock.unlock();
        }
    }

    public CarritoStateDTO vaciar(String username, CarritoStateDTO.Origen origen) {
        EspacioUsuario esp = espacioDe(username);
        esp.lock.lock();
        try {
            esp.items.clear();
            CarritoStateDTO state = snapshot(esp, origen);
            broadcast(username, state);
            return state;
        } finally {
            esp.lock.unlock();
        }
    }

    /**
     * Refresca contra DUX el stock de todos los items del carrito del usuario.
     * <b>No toca los precios</b>: el cliente paga lo que vio al armar el pedido,
     * aunque DUX haya cambiado el precio entre el scan y el envío. Sí se
     * actualizan stock, descripción, imagen, habilitado y flags de
     * sincronización porque son metadata que el operador debe ver.
     *
     * <p>Si DUX recorta el stock por debajo de la cantidad pedida en algún
     * item, el frontend lo verá al recibir el SSE — la decisión de qué hacer
     * (recortar o mantener) la sigue tomando el operador en pantalla.
     */
    public CarritoStateDTO refrescarStock(String username) {
        EspacioUsuario esp = espacioDe(username);
        List<String> skus;
        esp.lock.lock();
        try {
            // Solo los items normales se refrescan contra DUX. Los genéricos
            // no tienen producto real en catálogo — el SKU comodín no representa
            // un item con stock o precio que tenga sentido sincronizar.
            skus = esp.items.values().stream()
                    .filter(it -> !it.generico())
                    .map(CarritoItemDTO::sku)
                    .distinct()
                    .toList();
        } finally {
            esp.lock.unlock();
        }
        if (skus.isEmpty()) {
            return obtener(username);
        }

        // FUERA del lock: cada SKU consume 1 request DUX (~7s). No podemos
        // tener el lock tomado mientras esperamos a la red.
        List<ProductoCache> frescos = catalogoSync.refrescarSkus(skus);
        Map<String, ScanResultDTO> porSku = new LinkedHashMap<>();
        for (ProductoCache pc : frescos) {
            porSku.put(pc.getSku(), showroomService.toScanResult(pc));
        }

        esp.lock.lock();
        try {
            for (Map.Entry<String, CarritoItemDTO> e : esp.items.entrySet()) {
                CarritoItemDTO item = e.getValue();
                if (item.generico()) continue;
                ScanResultDTO fresh = porSku.get(item.sku());
                if (fresh != null) {
                    esp.items.put(e.getKey(), item.withStockFrescoDe(fresh));
                }
            }
            CarritoStateDTO state = snapshot(esp, CarritoStateDTO.Origen.OPERADOR);
            broadcast(username, state);
            return state;
        } finally {
            esp.lock.unlock();
        }
    }

    /**
     * Listener para {@link SesionCerradaEvent}: vacía el carrito DEL OPERADOR
     * que cerró la sesión, no de todos. Sin esto, el siguiente cliente del
     * mismo operador heredaría los items del anterior. Idempotente: si el
     * carrito ya está vacío, no hace ruido.
     */
    @EventListener
    public void onSesionCerrada(SesionCerradaEvent event) {
        String username = event.username();
        if (username == null || username.isBlank()) return;
        EspacioUsuario esp = espacios.get(username);
        if (esp == null) return;
        esp.lock.lock();
        try {
            if (esp.items.isEmpty()) return;
            log.info("Carrito de '{}' vaciado: sesión {} ({}) {} con {} item(s)",
                    username, event.sesionId(), event.nombreCliente(),
                    event.motivo().name().toLowerCase(), esp.items.size());
            esp.items.clear();
            broadcast(username, snapshot(esp, CarritoStateDTO.Origen.SISTEMA));
        } finally {
            esp.lock.unlock();
        }
    }

    @EventListener
    public void onSyncCatalogoCompletado(SyncCatalogoCompletadoEvent event) {
        // Refrescar todos los carritos de todos los operadores con la metadata
        // actualizada del catálogo. Iteramos los espacios; cada operador
        // recibe su propio broadcast solo si tuvo cambios.
        for (Map.Entry<String, EspacioUsuario> e : espacios.entrySet()) {
            String username = e.getKey();
            EspacioUsuario esp = e.getValue();
            esp.lock.lock();
            try {
                if (esp.items.isEmpty()) continue;
                boolean huboCambio = false;
                for (Map.Entry<String, CarritoItemDTO> entry : esp.items.entrySet()) {
                    CarritoItemDTO item = entry.getValue();
                    if (item.generico()) continue;
                    var pcOpt = catalogoSync.buscarPorSkuOEan(item.sku());
                    if (pcOpt.isEmpty()) continue;
                    ScanResultDTO fresh = showroomService.toScanResult(pcOpt.get());
                    CarritoItemDTO actualizado = item.withStockFrescoDe(fresh);
                    if (!actualizado.equals(item)) {
                        esp.items.put(entry.getKey(), actualizado);
                        huboCambio = true;
                    }
                }
                if (huboCambio) {
                    log.info("Carrito de '{}' actualizado tras sync ({} productos en catálogo)",
                            username, event.productosActualizados());
                    broadcast(username, snapshot(esp, CarritoStateDTO.Origen.SISTEMA));
                }
            } finally {
                esp.lock.unlock();
            }
        }
    }

    /** Crea (o reutiliza) el espacio del usuario. Null/blank cae al espacio
     *  "anónimo" — no debería ocurrir en producción (todo endpoint llega con
     *  username resuelto), pero si pasa no rompemos: el flujo sigue, solo
     *  que ese carrito no tiene broadcast útil. */
    private EspacioUsuario espacioDe(String username) {
        String key = (username == null || username.isBlank()) ? "" : username;
        return espacios.computeIfAbsent(key, k -> new EspacioUsuario());
    }

    /** Lectura inmutable del estado del usuario. El caller ya debe tener el lock. */
    private CarritoStateDTO snapshot(EspacioUsuario esp, CarritoStateDTO.Origen origen) {
        return CarritoStateDTO.of(new ArrayList<>(esp.items.values()), origen);
    }

    private void broadcast(String username, CarritoStateDTO state) {
        eventService.publishTo(username, EVENTO_CARRITO, state);
    }

    /** Estado privado por usuario. Cada uno tiene su lock independiente para
     *  no serializar a operadores distintos contra el mismo monitor. */
    private static final class EspacioUsuario {
        final ReentrantLock lock = new ReentrantLock();
        final Map<String, CarritoItemDTO> items = new LinkedHashMap<>();
    }
}
