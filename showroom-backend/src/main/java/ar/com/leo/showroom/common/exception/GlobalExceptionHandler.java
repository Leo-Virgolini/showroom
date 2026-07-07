package ar.com.leo.showroom.common.exception;

import jakarta.servlet.http.HttpServletRequest;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.client.HttpStatusCodeException;
import org.springframework.web.context.request.async.AsyncRequestNotUsableException;

import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.stream.Collectors;

@Slf4j
@RestControllerAdvice
public class GlobalExceptionHandler {

    @ExceptionHandler(NotFoundException.class)
    public ResponseEntity<Map<String, Object>> handleNotFound(NotFoundException ex, HttpServletRequest req) {
        return body(HttpStatus.NOT_FOUND, ex.getMessage(), req);
    }

    @ExceptionHandler(ConflictException.class)
    public ResponseEntity<Map<String, Object>> handleConflict(ConflictException ex, HttpServletRequest req) {
        return body(HttpStatus.CONFLICT, ex.getMessage(), req);
    }

    @ExceptionHandler(GoneException.class)
    public ResponseEntity<Map<String, Object>> handleGone(GoneException ex, HttpServletRequest req) {
        return body(HttpStatus.GONE, ex.getMessage(), req);
    }

    @ExceptionHandler(ServiceNotConfiguredException.class)
    public ResponseEntity<Map<String, Object>> handleNotConfigured(ServiceNotConfiguredException ex, HttpServletRequest req) {
        log.warn("Servicio no configurado: {}", ex.getMessage());
        return body(HttpStatus.SERVICE_UNAVAILABLE, ex.getMessage(), req);
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<Map<String, Object>> handleValidation(MethodArgumentNotValidException ex, HttpServletRequest req) {
        String msg = ex.getBindingResult().getFieldErrors().stream()
                .map(fe -> fe.getField() + ": " + fe.getDefaultMessage())
                .collect(Collectors.joining(", "));
        return body(HttpStatus.BAD_REQUEST, msg, req);
    }

    @ExceptionHandler(HttpStatusCodeException.class)
    public ResponseEntity<Map<String, Object>> handleUpstream(HttpStatusCodeException ex, HttpServletRequest req) {
        log.warn("Error upstream {}: {}", ex.getStatusCode(), ex.getResponseBodyAsString());
        return body(HttpStatus.BAD_GATEWAY, UserMessages.mensajeUpstream(ex), req);
    }

    @ExceptionHandler(IllegalArgumentException.class)
    public ResponseEntity<Map<String, Object>> handleBadRequest(IllegalArgumentException ex, HttpServletRequest req) {
        return body(HttpStatus.BAD_REQUEST, ex.getMessage(), req);
    }

    /**
     * Cliente cerró la conexión antes de que terminara la response (típico
     * en SSE: tablet se durmió, browser cerrado, red caída). No hay nada que
     * devolver — devolver body causaría
     * {@code HttpMessageNotWritableException} porque el response ya está
     * marcado como {@code text/event-stream} y el converter de JSON falla.
     */
    @ExceptionHandler({AsyncRequestNotUsableException.class, IOException.class})
    public void handleClientDisconnect(Exception ex, HttpServletRequest req) {
        log.debug("Cliente desconectado en {}: {}", req.getRequestURI(), ex.getMessage());
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<Map<String, Object>> handleGeneric(Exception ex, HttpServletRequest req) {
        log.error("Error interno", ex);
        // No exponemos ex.getMessage() crudo — suele ser texto técnico (NPE,
        // stacktrace de una lib) que no le sirve al operador. El detalle queda en
        // el log para diagnóstico; en pantalla devolvemos algo traducible o un
        // fallback genérico.
        String msg = UserMessages.traducir(ex,
                "Ocurrió un error inesperado. Revisá los logs del backend para más detalle.");
        return body(HttpStatus.INTERNAL_SERVER_ERROR, msg, req);
    }

    private ResponseEntity<Map<String, Object>> body(HttpStatus status, String message, HttpServletRequest req) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("message", message);
        body.put("path", req.getRequestURI());
        return ResponseEntity.status(status).body(body);
    }
}
