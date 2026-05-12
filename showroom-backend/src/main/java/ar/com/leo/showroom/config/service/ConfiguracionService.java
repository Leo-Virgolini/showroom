package ar.com.leo.showroom.config.service;

import ar.com.leo.showroom.config.entity.Configuracion;
import ar.com.leo.showroom.config.repository.ConfiguracionRepository;
import ar.com.leo.showroom.showroom.dto.PickitConfigDTO;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.regex.Pattern;

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

    /** Destinatario del email de picking. Acepta uno o varios mails separados por coma. */
    public static final String CLAVE_PICKING_EMAIL_TO = "picking.email-to";

    /** Integración con el programa pickit-y-etiquetas (jar nativo en el host,
     *  ejecutado por el backend vía ProcessBuilder). */
    public static final String CLAVE_PICKIT_ENABLED = "pickit.enabled";
    public static final String CLAVE_PICKIT_JAR_PATH = "pickit.jar-path";
    public static final String CLAVE_PICKIT_STOCK_FILE = "pickit.stock-file";
    public static final String CLAVE_PICKIT_COMBOS_FILE = "pickit.combos-file";
    public static final String CLAVE_PICKIT_OUTPUT_DIR = "pickit.output-dir";

    /**
     * Validación liviana: una o varias direcciones separadas por coma. No
     * pretende cubrir el RFC entero — solo descarta entradas obviamente
     * inválidas (sin {@code @}, espacios, etc.).
     */
    private static final Pattern EMAIL_LIKE = Pattern.compile("^[^@\\s,]+@[^@\\s,]+\\.[^@\\s,]+$");

    private final ConfiguracionRepository repository;

    /**
     * Devuelve el destinatario configurado en BD, o cadena vacía si no hay
     * fila. Sin fallback a properties/env — si está vacío, el envío queda
     * deshabilitado.
     */
    @Transactional(readOnly = true)
    public String getEmailPickingTo() {
        return repository.findById(CLAVE_PICKING_EMAIL_TO)
                .map(Configuracion::getValor)
                .orElse("");
    }

    /**
     * Persiste el destinatario del email de picking. Pasar cadena vacía
     * borra la fila — a partir de ese momento el envío queda deshabilitado.
     * El valor se trimma antes de guardar.
     *
     * @return el valor efectivo después de guardar (para que el frontend
     *         actualice su estado sin tener que pedir el GET de nuevo).
     */
    @Transactional
    public String setEmailPickingTo(String emailTo) {
        String valor = emailTo == null ? "" : emailTo.trim();
        validarEmailTo(valor);
        if (valor.isEmpty()) {
            repository.deleteById(CLAVE_PICKING_EMAIL_TO);
            log.info("Email de picking limpiado — el envío queda deshabilitado");
            return "";
        }
        repository.save(Configuracion.builder()
                .clave(CLAVE_PICKING_EMAIL_TO)
                .valor(valor)
                .build());
        log.info("Email de picking actualizado: {}", valor);
        return valor;
    }

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
                leer(CLAVE_PICKIT_OUTPUT_DIR));
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

    private static void validarEmailTo(String valor) {
        if (valor.isEmpty()) return; // vacío = borrar la config, es válido
        for (String parte : valor.split("\\s*,\\s*")) {
            if (parte.isBlank()) {
                throw new IllegalArgumentException("Email inválido (entrada vacía entre comas)");
            }
            if (!EMAIL_LIKE.matcher(parte).matches()) {
                throw new IllegalArgumentException("Email inválido: " + parte);
            }
        }
    }

}
