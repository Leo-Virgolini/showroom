package ar.com.leo.showroom.cotizacion.dto;

import jakarta.validation.Valid;
import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;

/**
 * Wrapper sobre {@link GenerarCotizacionRequestDTO} para el endpoint de
 * envío por email — fuerza que el email del cliente esté presente y sea
 * válido (en el preview es opcional).
 */
public record EnviarCotizacionRequestDTO(
        @NotBlank(message = "Falta el email del cliente")
        @Email(message = "El email del cliente no tiene un formato válido")
        String email,

        @NotNull
        @Valid
        GenerarCotizacionRequestDTO cotizacion
) {}
