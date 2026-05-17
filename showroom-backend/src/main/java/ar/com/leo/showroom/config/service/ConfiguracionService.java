package ar.com.leo.showroom.config.service;

import ar.com.leo.showroom.config.entity.Configuracion;
import ar.com.leo.showroom.config.repository.ConfiguracionRepository;
import ar.com.leo.showroom.showroom.dto.NotificacionesAutoConfigDTO;
import ar.com.leo.showroom.showroom.dto.PickitConfigDTO;
import ar.com.leo.showroom.showroom.dto.WhatsappMensajeConfigDTO;
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

    /** Toggles de envío automático del PDF tras pedido OK. NO afectan los
     *  botones manuales en /pedidos ni /historial — esos siguen disponibles
     *  siempre que el feature a nivel sistema (env vars SMTP/Meta) esté ok. */
    public static final String CLAVE_AUTO_EMAIL_PEDIDO = "notificaciones.email-auto-pedido";
    public static final String CLAVE_AUTO_WHATSAPP_PEDIDO = "notificaciones.whatsapp-auto-pedido";

    /** Habilita/deshabilita la sincronización automática con DUX. Cuando es
     *  false los disparos programados (horarios) se saltean sin ejecutar — el
     *  operador puede dejar configurados sus horarios y solo pausar la sync
     *  con un toggle (ej: mientras DUX está caído). Default true. */
    public static final String CLAVE_SYNC_AUTO_HABILITADA = "sync.auto-habilitada";

    /** Cuerpo del mensaje (caption) que acompaña al PDF en WhatsApp. Soporta
     *  formato nativo de WhatsApp (*negrita*, _itálica_, ~tachado~, `mono`) y
     *  el placeholder {nombre}. Sin valor en DB → el PDF se manda sin caption. */
    public static final String CLAVE_WHATSAPP_MENSAJE_CUERPO = "whatsapp.mensaje-cuerpo";

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

    // =====================================================================
    // Notificaciones automáticas tras pedido (email + whatsapp)
    // =====================================================================

    /** Lee los toggles. Default {@code true} para ambos: si la fila no existe,
     *  asumimos que el operador quiere los envíos auto activos. */
    @Transactional(readOnly = true)
    public NotificacionesAutoConfigDTO getNotificacionesAuto() {
        return new NotificacionesAutoConfigDTO(
                leerBool(CLAVE_AUTO_EMAIL_PEDIDO, true),
                leerBool(CLAVE_AUTO_WHATSAPP_PEDIDO, true)
        );
    }

    @Transactional
    public NotificacionesAutoConfigDTO saveNotificacionesAuto(NotificacionesAutoConfigDTO cfg) {
        if (cfg == null) {
            throw new IllegalArgumentException("Config requerida");
        }
        guardar(CLAVE_AUTO_EMAIL_PEDIDO, cfg.emailAutoPedido() ? "true" : "false");
        guardar(CLAVE_AUTO_WHATSAPP_PEDIDO, cfg.whatsappAutoPedido() ? "true" : "false");
        log.info("Config notificaciones auto guardada: emailPedido={}, whatsappPedido={}",
                cfg.emailAutoPedido(), cfg.whatsappAutoPedido());
        return getNotificacionesAuto();
    }

    private boolean leerBool(String clave, boolean defaultSiAusente) {
        String v = leer(clave);
        if (v == null || v.isEmpty()) return defaultSiAusente;
        return "true".equalsIgnoreCase(v);
    }

    // =====================================================================
    // Sincronización automática con DUX (toggle global)
    // =====================================================================

    /** Default {@code true}: si la fila no existe (primera vez), asumimos que
     *  el operador quiere la sync auto activa. */
    @Transactional(readOnly = true)
    public boolean isSyncAutoHabilitada() {
        return leerBool(CLAVE_SYNC_AUTO_HABILITADA, true);
    }

    @Transactional
    public boolean setSyncAutoHabilitada(boolean habilitada) {
        guardar(CLAVE_SYNC_AUTO_HABILITADA, habilitada ? "true" : "false");
        log.info("Sync automática DUX {}", habilitada ? "HABILITADA" : "DESHABILITADA");
        return habilitada;
    }

    // =====================================================================
    // Mensaje de WhatsApp (caption del PDF) — editable desde /configuracion
    // =====================================================================

    /**
     * Devuelve el mensaje que acompaña al PDF en WhatsApp. Si el operador no
     * lo configuró desde {@code /configuracion}, devuelve cadena vacía con
     * {@code personalizado=false}: el PDF se enviará sin caption.
     */
    @Transactional(readOnly = true)
    public WhatsappMensajeConfigDTO getWhatsappMensaje() {
        String valor = leer(CLAVE_WHATSAPP_MENSAJE_CUERPO);
        boolean personalizado = valor != null && !valor.isEmpty();
        return new WhatsappMensajeConfigDTO(personalizado ? valor : "", personalizado);
    }

    /**
     * Cuerpo del mensaje que efectivamente se va a usar al enviar. Lo consume
     * {@link ar.com.leo.showroom.picking.WhatsappBusinessService} en cada envío.
     * Devuelve cadena vacía si el operador todavía no configuró ningún mensaje
     * (el PDF se manda sin caption).
     */
    @Transactional(readOnly = true)
    public String getWhatsappMensajeCuerpo() {
        return leer(CLAVE_WHATSAPP_MENSAJE_CUERPO);
    }

    /**
     * Persiste el mensaje custom. Pasar vacío borra la fila — el PDF se va a
     * mandar sin caption hasta que se cargue uno nuevo. Cap de 1024 caracteres
     * porque es el límite del caption de WhatsApp.
     */
    @Transactional
    public WhatsappMensajeConfigDTO saveWhatsappMensaje(WhatsappMensajeConfigDTO cfg) {
        if (cfg == null) {
            throw new IllegalArgumentException("Config requerida");
        }
        String mensaje = cfg.mensaje() == null ? "" : cfg.mensaje();
        if (mensaje.length() > 1024) {
            throw new IllegalArgumentException(
                    "El mensaje supera el máximo de 1024 caracteres permitido por WhatsApp.");
        }
        guardar(CLAVE_WHATSAPP_MENSAJE_CUERPO, mensaje);
        log.info("Mensaje de WhatsApp {} ({} chars)",
                mensaje.isEmpty() ? "BORRADO" : "actualizado",
                mensaje.length());
        return getWhatsappMensaje();
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
