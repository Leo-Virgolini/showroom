package ar.com.leo.showroom.config.service;

import ar.com.leo.showroom.config.entity.Configuracion;
import ar.com.leo.showroom.config.repository.ConfiguracionRepository;
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

    /** Host:puerto del servidor para el QR del visor (ej. {@code 192.168.1.50:4200}). */
    public static final String CLAVE_VISOR_HOST = "visor.host";

    /**
     * Validación liviana: una o varias direcciones separadas por coma. No
     * pretende cubrir el RFC entero — solo descarta entradas obviamente
     * inválidas (sin {@code @}, espacios, etc.).
     */
    private static final Pattern EMAIL_LIKE = Pattern.compile("^[^@\\s,]+@[^@\\s,]+\\.[^@\\s,]+$");

    /**
     * Host válido: IP o hostname con puerto opcional. No queremos slashes,
     * espacios, ni protocolo (que se agrega del lado del frontend).
     */
    private static final Pattern HOST_LIKE = Pattern.compile("^[a-zA-Z0-9.\\-]+(:\\d{1,5})?$");

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

    /**
     * Devuelve el host del visor configurado (IP o hostname con puerto), o
     * cadena vacía si no se cargó. El frontend usa este valor para armar la
     * URL del QR; si está vacío cae al {@code window.location.host} del browser.
     */
    @Transactional(readOnly = true)
    public String getVisorHost() {
        return repository.findById(CLAVE_VISOR_HOST)
                .map(Configuracion::getValor)
                .orElse("");
    }

    /**
     * Persiste el host del visor (ej. {@code 192.168.1.50:4200}). Cadena vacía
     * borra la config — el frontend cae al host del browser.
     */
    @Transactional
    public String setVisorHost(String host) {
        String valor = host == null ? "" : host.trim();
        validarHost(valor);
        if (valor.isEmpty()) {
            repository.deleteById(CLAVE_VISOR_HOST);
            log.info("Host del visor limpiado — el frontend usa el host del browser");
            return "";
        }
        repository.save(Configuracion.builder()
                .clave(CLAVE_VISOR_HOST)
                .valor(valor)
                .build());
        log.info("Host del visor actualizado: {}", valor);
        return valor;
    }

    private static void validarHost(String valor) {
        if (valor.isEmpty()) return;
        if (!HOST_LIKE.matcher(valor).matches()) {
            throw new IllegalArgumentException(
                    "Host inválido: usá IP o hostname con puerto opcional, sin barras ni protocolo (ej. 192.168.1.50:4200)");
        }
    }
}
