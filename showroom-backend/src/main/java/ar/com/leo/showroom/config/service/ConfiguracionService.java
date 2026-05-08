package ar.com.leo.showroom.config.service;

import ar.com.leo.showroom.config.entity.Configuracion;
import ar.com.leo.showroom.config.repository.ConfiguracionRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.regex.Pattern;

/**
 * Lectura/escritura de configuración runtime (tabla {@code configuracion}).
 * Cada clave puede tener un default en {@code application.properties}: si la BD
 * no tiene fila para esa clave, se devuelve el default. Cuando el operador
 * guarda un valor desde la UI, queda persistido y a partir de ese momento la
 * BD pisa al default.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class ConfiguracionService {

    /** Destinatario del email de picking. Acepta uno o varios mails separados por coma. */
    public static final String CLAVE_PICKING_EMAIL_TO = "picking.email-to";

    /**
     * Validación liviana: una o varias direcciones separadas por coma. No
     * pretende cubrir el RFC entero — solo descarta entradas obviamente
     * inválidas (sin {@code @}, espacios, etc.).
     */
    private static final Pattern EMAIL_LIKE = Pattern.compile("^[^@\\s,]+@[^@\\s,]+\\.[^@\\s,]+$");

    private final ConfiguracionRepository repository;

    @Value("${showroom.picking.email-to:}")
    private String emailToDefault;

    /**
     * Devuelve el destinatario configurado en BD; si no hay fila, cae al
     * default de {@code application.properties}. Puede ser cadena vacía si
     * tampoco hay default — el caller debe chequear con
     * {@link org.springframework.util.StringUtils#hasText} antes de usarlo.
     */
    @Transactional(readOnly = true)
    public String getEmailPickingTo() {
        return repository.findById(CLAVE_PICKING_EMAIL_TO)
                .map(Configuracion::getValor)
                .orElse(emailToDefault == null ? "" : emailToDefault);
    }

    /**
     * Persiste el destinatario del email de picking. Pasar cadena vacía
     * "borra" la configuración (vuelve a usar el default). El valor se
     * trimma antes de guardar.
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
            return emailToDefault == null ? "" : emailToDefault;
        }
        repository.save(Configuracion.builder()
                .clave(CLAVE_PICKING_EMAIL_TO)
                .valor(valor)
                .build());
        log.info("Email de picking actualizado: {}", valor);
        return valor;
    }

    private static void validarEmailTo(String valor) {
        if (valor.isEmpty()) return; // vacío = "vuelve al default", es válido
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
