package ar.com.leo.showroom.presupuesto.dto;

import jakarta.validation.Valid;
import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;

/**
 * Wrapper sobre {@link GenerarPresupuestoRequestDTO} para el endpoint de envío
 * por email — fuerza que el email del cliente esté presente y sea válido (en
 * el preview es opcional).
 */
public record EnviarPresupuestoRequestDTO(
        @NotBlank(message = "Falta el email del cliente")
        @Email(message = "El email del cliente no tiene un formato válido")
        String email,

        @NotNull
        @Valid
        GenerarPresupuestoRequestDTO presupuesto
) {}
