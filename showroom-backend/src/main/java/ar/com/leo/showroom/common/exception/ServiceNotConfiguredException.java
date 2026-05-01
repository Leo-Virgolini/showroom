package ar.com.leo.showroom.common.exception;

public class ServiceNotConfiguredException extends RuntimeException {
    public ServiceNotConfiguredException(String service, String message) {
        super("[" + service + "] " + message);
    }
}
