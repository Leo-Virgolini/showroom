package ar.com.leo.showroom.common.exception;

import jakarta.mail.AuthenticationFailedException;
import jakarta.mail.SendFailedException;
import org.springframework.web.client.HttpStatusCodeException;

import java.net.ConnectException;
import java.net.SocketTimeoutException;
import java.net.UnknownHostException;

/**
 * Traduce excepciones técnicas (timeouts SMTP, errores upstream de DUX, fallos de
 * red) a mensajes en español pensados para que el operador del showroom entienda
 * qué pasó y qué hacer. El log con stacktrace queda intacto en el caller — esto
 * sólo arma el texto que se muestra en pantalla.
 */
public final class UserMessages {

    private UserMessages() {}

    /**
     * Recorre la cadena de causas buscando una excepción conocida. Si no
     * encuentra ninguna, devuelve el fallback. Útil para el catch genérico
     * en services que llaman a integraciones externas.
     */
    public static String traducir(Throwable e, String fallback) {
        for (Throwable cur = e; cur != null; cur = cur.getCause()) {
            String specific = mensajeEspecifico(cur);
            if (specific != null) return specific;
        }
        return fallback;
    }

    private static String mensajeEspecifico(Throwable cur) {
        if (cur instanceof SocketTimeoutException) {
            return "Tiempo de espera agotado contactando al servicio externo. Reintentá en un momento.";
        }
        if (cur instanceof UnknownHostException) {
            return "No se pudo resolver el host del servicio. ¿Hay conexión a internet en el servidor?";
        }
        if (cur instanceof ConnectException) {
            return "No se pudo conectar al servicio externo. Revisá la red del servidor.";
        }
        if (cur instanceof HttpStatusCodeException http) {
            return mensajeUpstream(http);
        }
        if (cur instanceof AuthenticationFailedException) {
            return "Credenciales de Gmail rechazadas. Hay que regenerar la App Password en la configuración.";
        }
        if (cur instanceof SendFailedException) {
            return "El servidor SMTP rechazó algún destinatario. Verificá los emails configurados.";
        }
        String msg = cur.getMessage();
        if (msg != null && msg.toLowerCase().contains("timed out")) {
            return "Tiempo de espera agotado contactando al servicio externo. Reintentá en un momento.";
        }
        return null;
    }

    public static String mensajeUpstream(HttpStatusCodeException ex) {
        int code = ex.getStatusCode().value();
        if (code == 429) {
            return "DUX está saturado (rate-limit). Esperá unos segundos y reintentá.";
        }
        if (code == 401 || code == 403) {
            return "DUX rechazó las credenciales. Probá relogear desde la configuración.";
        }
        if (code == 404) {
            return "El recurso solicitado no existe en DUX.";
        }
        if (code >= 500) {
            return "DUX está caído o respondiendo con error. Reintentá en un rato.";
        }
        return "DUX respondió con un error (" + code + "). Reintentá o revisá los logs.";
    }
}
