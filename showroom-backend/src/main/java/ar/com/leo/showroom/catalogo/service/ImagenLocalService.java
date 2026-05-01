package ar.com.leo.showroom.catalogo.service;

import jakarta.annotation.PostConstruct;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.io.File;
import java.util.HashMap;
import java.util.Map;
import java.util.Optional;

/**
 * Sirve imágenes de productos desde una carpeta local — la misma que usa
 * PresupuestoPdfGenerator vía {@code showroom.presupuesto.imagenes-folder}.
 *
 * Para que el lookup sea O(1) aunque la carpeta tenga decenas de miles de
 * archivos (caso real: ~17.700), mantenemos un índice {sku → File} en memoria
 * que se construye al startup. Sin índice, cada request implicaría stat calls
 * o un listFiles de toda la carpeta, lo que con 50 productos por listado escala mal.
 *
 * El índice se reconstruye:
 *  - Al startup (PostConstruct).
 *  - On-demand vía {@code POST /api/showroom/imagenes/reindex} cuando el cliente
 *    sube imágenes nuevas (no hay refresh periódico — la carpeta cambia poco).
 */
@Slf4j
@Service
public class ImagenLocalService {

    /** Orden de prioridad cuando hay varios archivos con el mismo SKU pero
     *  distinta extensión (ej. {@code 1011000.jpg} y {@code 1011000.png}). */
    private static final String[] EXTENSIONES_PRIORIDAD = {
            ".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"
    };

    @Value("${showroom.presupuesto.imagenes-folder:}")
    private String folderPath;

    /** Índice {sku-en-lowercase → File}. Volatile porque se reescribe entero
     *  en cada refresh; los lectores siempre ven una snapshot consistente. */
    private volatile Map<String, File> index = Map.of();

    @PostConstruct
    public void init() {
        recargarIndice();
    }

    /**
     * Reescanea la carpeta y reconstruye el índice de cero. Es seguro llamarlo
     * mientras hay lookups concurrentes — los lectores ven el snapshot viejo
     * hasta que el reemplazo del campo {@code volatile} es visible.
     */
    public synchronized void recargarIndice() {
        if (folderPath == null || folderPath.isBlank()) {
            this.index = Map.of();
            return;
        }
        File folder = new File(folderPath);
        if (!folder.isDirectory()) {
            log.warn("Carpeta de imágenes no existe o no es directorio: {}", folderPath);
            this.index = Map.of();
            return;
        }
        long t0 = System.currentTimeMillis();
        File[] archivos = folder.listFiles(File::isFile);
        if (archivos == null) {
            this.index = Map.of();
            return;
        }
        Map<String, File> nuevo = new HashMap<>(archivos.length);
        for (File f : archivos) {
            String name = f.getName();
            int dot = name.lastIndexOf('.');
            if (dot <= 0) continue;
            String sku = name.substring(0, dot).toLowerCase();
            // Si hay duplicados (mismo SKU con distinta extensión), nos quedamos
            // con la de mayor prioridad según EXTENSIONES_PRIORIDAD.
            File existente = nuevo.get(sku);
            if (existente == null || prioridad(f) < prioridad(existente)) {
                nuevo.put(sku, f);
            }
        }
        this.index = Map.copyOf(nuevo);
        long ms = System.currentTimeMillis() - t0;
        log.info("Índice de imágenes recargado: {} archivos en {}ms (carpeta: {})",
                nuevo.size(), ms, folderPath);
    }

    public Optional<File> buscar(String sku) {
        if (sku == null || sku.isBlank()) return Optional.empty();
        File f = index.get(sku.toLowerCase());
        // Doble check por si el archivo se borró del disco entre refreshes —
        // evita 200 OK con un FileSystemResource que después falla al leerse.
        return (f != null && f.isFile()) ? Optional.of(f) : Optional.empty();
    }

    public int getTotalArchivos() {
        return index.size();
    }

    private static int prioridad(File f) {
        String name = f.getName().toLowerCase();
        for (int i = 0; i < EXTENSIONES_PRIORIDAD.length; i++) {
            if (name.endsWith(EXTENSIONES_PRIORIDAD[i])) return i;
        }
        return 999;
    }
}
