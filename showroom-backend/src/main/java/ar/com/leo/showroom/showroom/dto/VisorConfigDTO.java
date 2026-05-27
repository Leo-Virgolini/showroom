package ar.com.leo.showroom.showroom.dto;

/**
 * URL base con la que el frontend arma el QR del visor (ej.
 * {@code http://192.168.1.50:4200}).
 *
 * <p>El operador la configura desde /configuracion. Sirve para cuando entra a
 * la app por un hostname/DNS interno (ej. "servidor") que los celulares de los
 * clientes no pueden resolver: con esto el QR apunta a la IP de red local, que
 * sí es alcanzable desde el celular. Si queda vacía, el frontend cae a
 * {@code window.location.origin}.
 */
public record VisorConfigDTO(
        String baseUrl
) {
}
