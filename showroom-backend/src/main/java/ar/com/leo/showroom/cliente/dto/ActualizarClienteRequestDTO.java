package ar.com.leo.showroom.cliente.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/**
 * Payload del endpoint PUT /cliente-master — upsert por teléfono.
 *
 * <p>El {@code telefono} viene como lo tipeó el operador (con o sin guiones);
 * el service lo normaliza antes de usar como clave. Los demás campos pueden
 * venir null/vacíos: el master los guarda como null y el merge en
 * /clientes los ignora (cae al valor del último movimiento).
 */
public record ActualizarClienteRequestDTO(
        @NotBlank @Size(max = 50) String telefono,
        @Size(max = 150) String razonSocial,
        @Size(max = 150) String nombre,
        @Size(max = 150) String email,
        @Size(max = 100) String rubro,
        @Size(max = 2000) String notas,
        // ---- Datos de facturación y envío (opcionales) ----
        @Size(max = 10) String tipoDoc,
        Long nroDoc,
        @Size(max = 200) String domicilio,
        @Size(max = 10) String codigoProvincia,
        @Size(max = 20) String idLocalidad
) {
}
