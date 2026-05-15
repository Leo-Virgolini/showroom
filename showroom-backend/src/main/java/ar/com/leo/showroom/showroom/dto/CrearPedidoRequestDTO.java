package ar.com.leo.showroom.showroom.dto;

import jakarta.validation.Valid;
import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Positive;
import jakarta.validation.constraints.Size;

import java.math.BigDecimal;
import java.util.List;

/**
 * Payload del frontend para crear un pedido en DUX.
 * Espeja los campos requeridos/opcionales de POST /pedido/nuevopedido.
 *
 * Doc: https://duxsoftware.readme.io/reference/crear-pedido
 */
public record CrearPedidoRequestDTO(
        @NotBlank(message = "apellidoRazonSocial requerido")
        String apellidoRazonSocial,

        String nombre,

        @Pattern(
                regexp = "^(CONSUMIDOR_FINAL|RESPONSABLE_INSCRIPTO|EXENTO|MONOTRIBUTISTA)?$",
                message = "categoriaFiscal inválida"
        )
        String categoriaFiscal,

        @Pattern(regexp = "^(DNI|CUIT|CUIL)?$", message = "tipoDoc inválido")
        String tipoDoc,
        /** Long para soportar CUIT/CUIL de 11 dígitos. */
        Long nroDoc,

        String codigoCliente,
        String telefono,

        @NotBlank(message = "email requerido — se usa para mandar al cliente el PDF con los productos vistos")
        @Email(message = "email inválido")
        String email,

        String domicilio,
        String codigoProvincia,
        String idLocalidad,

        @Size(max = 100, message = "referencia max 100 chars")
        String referencia,

        @Size(max = 500, message = "observaciones max 500 chars")
        String observaciones,

        /** Forma de pago elegida (FK opcional a forma_pago.id). Si presente,
         *  el backend aplica el recargo % de esa forma a cada precio unitario
         *  antes de mandar a DUX, y snapshotea nombre/recargo/cuotas en el
         *  pedido. Si null, el pedido va sin recargo (precios base). */
        Long formaPagoId,

        @NotEmpty(message = "items no puede estar vacío")
        @Valid List<Item> items
) {
    public record Item(
            @NotNull String sku,
            @NotNull @Positive Integer cantidad,
            BigDecimal precioUnitario,
            BigDecimal descuentoPorcentaje
    ) {
    }
}
