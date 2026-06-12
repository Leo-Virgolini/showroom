package ar.com.leo.showroom.cliente.dto;

/**
 * Datos de un cliente para autocompletar el formulario de pedido cuando el
 * operador tipea un CUIT/razón social ya conocido. Se resuelve SOLO desde el
 * maestro de clientes ({@code ClienteMaster}) — sin fallback al historial.
 * Todos los campos son opcionales — el frontend completa solo los que están
 * vacíos.
 */
public record ClienteAutocompletarDTO(
        String razonSocial,
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
