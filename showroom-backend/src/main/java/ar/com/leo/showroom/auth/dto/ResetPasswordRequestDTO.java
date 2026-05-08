package ar.com.leo.showroom.auth.dto;

import jakarta.validation.constraints.NotBlank;

public record ResetPasswordRequestDTO(
        @NotBlank String passwordNuevo
) {
}
