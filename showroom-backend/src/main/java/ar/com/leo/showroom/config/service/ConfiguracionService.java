package ar.com.leo.showroom.config.service;

import ar.com.leo.showroom.config.entity.Configuracion;
import ar.com.leo.showroom.config.repository.ConfiguracionRepository;
import ar.com.leo.showroom.showroom.dto.PickitConfigDTO;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Lectura/escritura de configuración runtime (tabla {@code configuracion}).
 * La BD es la única fuente de verdad — no hay fallback a propiedades ni a
 * variables de entorno. Si la fila no existe, se devuelve cadena vacía y el
 * caller debe chequear con {@link org.springframework.util.StringUtils#hasText}
 * antes de usar el valor.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class ConfiguracionService {

    /** Integración con el programa pickit-y-etiquetas (jar nativo en el host,
     *  ejecutado por el backend vía ProcessBuilder). */
    public static final String CLAVE_PICKIT_ENABLED = "pickit.enabled";
    public static final String CLAVE_PICKIT_JAR_PATH = "pickit.jar-path";
    public static final String CLAVE_PICKIT_STOCK_FILE = "pickit.stock-file";
    public static final String CLAVE_PICKIT_COMBOS_FILE = "pickit.combos-file";
    public static final String CLAVE_PICKIT_OUTPUT_DIR = "pickit.output-dir";

    private final ConfiguracionRepository repository;

    /**
     * Path del HOST mapeado al volumen {@code /app/pickit} del container (lo
     * setea docker-compose desde {@code PICKIT_HOST_PATH} del {@code .env}).
     * Se expone read-only en {@link PickitConfigDTO#hostPath()} para que la
     * pantalla de configuración pueda mostrarle al operador a qué carpeta del
     * host equivale el path del container que está escribiendo.
     */
    @Value("${showroom.pickit.host-path:}")
    private String pickitHostPath;

    // =====================================================================
    // Pickit externo (programa Java desktop)
    // =====================================================================

    @Transactional(readOnly = true)
    public PickitConfigDTO getPickitConfig() {
        return new PickitConfigDTO(
                "true".equalsIgnoreCase(leer(CLAVE_PICKIT_ENABLED)),
                leer(CLAVE_PICKIT_JAR_PATH),
                leer(CLAVE_PICKIT_STOCK_FILE),
                leer(CLAVE_PICKIT_COMBOS_FILE),
                leer(CLAVE_PICKIT_OUTPUT_DIR),
                pickitHostPath == null ? "" : pickitHostPath);
    }

    /**
     * Persiste la config completa del pickit. Si {@code enabled=true}, valida
     * que los 4 paths estén presentes (sino no podría ejecutarse después). Si
     * {@code enabled=false}, los paths pueden quedar en blanco — los conservamos
     * igual para no perder lo que el operador ya había configurado.
     */
    @Transactional
    public PickitConfigDTO savePickitConfig(PickitConfigDTO cfg) {
        if (cfg == null) {
            throw new IllegalArgumentException("Config requerida");
        }
        String jar = trim(cfg.jarPath());
        String stock = trim(cfg.stockFile());
        String combos = trim(cfg.combosFile());
        String out = trim(cfg.outputDir());
        if (cfg.enabled()) {
            if (jar.isEmpty()) throw new IllegalArgumentException("Path del jar requerido");
            if (stock.isEmpty()) throw new IllegalArgumentException("Path de Stock.xlsx requerido");
            if (combos.isEmpty()) throw new IllegalArgumentException("Path de Combos.xlsx requerido");
            if (out.isEmpty()) throw new IllegalArgumentException("Carpeta de salida requerida");
        }
        guardar(CLAVE_PICKIT_ENABLED, cfg.enabled() ? "true" : "false");
        guardar(CLAVE_PICKIT_JAR_PATH, jar);
        guardar(CLAVE_PICKIT_STOCK_FILE, stock);
        guardar(CLAVE_PICKIT_COMBOS_FILE, combos);
        guardar(CLAVE_PICKIT_OUTPUT_DIR, out);
        log.info("Config pickit guardada: enabled={}, jar={}, stock={}, combos={}, out={}",
                cfg.enabled(), jar, stock, combos, out);
        return getPickitConfig();
    }

    private String leer(String clave) {
        return repository.findById(clave).map(Configuracion::getValor).orElse("");
    }

    private void guardar(String clave, String valor) {
        if (valor == null || valor.isEmpty()) {
            repository.deleteById(clave);
        } else {
            repository.save(Configuracion.builder().clave(clave).valor(valor).build());
        }
    }

    private static String trim(String s) {
        return s == null ? "" : s.trim();
    }

}
