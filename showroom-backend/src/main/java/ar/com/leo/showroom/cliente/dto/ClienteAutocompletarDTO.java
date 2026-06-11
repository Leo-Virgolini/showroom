package ar.com.leo.showroom.cliente.dto;

/**
 * Datos de un cliente para autocompletar el formulario de pedido cuando el
 * operador tipea un CUIT ya conocido. Se resuelve desde el maestro de clientes
 * ({@code ClienteMaster}) o, como fallback, desde el último pedido con ese
 * documento. Todos los campos son opcionales — el frontend completa solo los
 * que están vacíos.
 */
public record ClienteAutocompletarDTO(
        String nombre,
        String email,
        String telefono,
        String rubro,
        String tipoDoc,
        Long nroDoc,
        String domicilio,
        String codigoProvincia,
        String idLocalidad
) {
}
