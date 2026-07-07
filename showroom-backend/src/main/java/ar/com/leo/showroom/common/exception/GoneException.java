package ar.com.leo.showroom.common.exception;

/** El recurso existió pero ya no está disponible (HTTP 410). Se usa para el
 *  token de visor de una sesión que ya cerró. */
public class GoneException extends RuntimeException {
    public GoneException(String message) {
        super(message);
    }
}
