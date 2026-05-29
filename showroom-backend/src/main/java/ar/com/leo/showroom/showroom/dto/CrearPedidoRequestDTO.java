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

        @NotBlank(message = "nombre del cliente requerido")
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

        @NotBlank(message = "teléfono del cliente requerido")
        String telefono,

        @NotBlank(message = "email requerido — se usa para mandar al cliente el PDF con los productos vistos")
        @Email(message = "email inválido")
        String email,

        /** Rubro comercial del cliente (bar/restaurant/panadería/otros). Lo usa
         *  la vista unificada de clientes en {@code /clientes} para mostrar y
         *  segmentar — sin esto, los clientes que llegan via pedido sin haber
         *  cotizado nunca tendrían rubro. */
        @NotBlank(message = "rubro del cliente requerido")
        String rubro,

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
            BigDecimal descuentoPorcentaje,
            /** % de IVA del producto (21 o 10.5 en AR). Solo se considera para
             *  ítems genéricos (SKU comodín de {@code dux.sku-producto-generico}):
             *  el cache del SKU 9999990 no tiene un IVA representativo del
             *  producto real, así que el operador lo elige en el dialog. Para
             *  ítems normales el backend usa el porcIva del cache. */
            BigDecimal porcIva,
            /** Texto libre que se manda como {@code comentarios} de la línea
             *  en el payload DUX y se persiste como detalle de la línea del
             *  pedido. Usado principalmente con el SKU comodín
             *  ({@code dux.sku-producto-generico}) para describir el producto
             *  real que no existe en catálogo. Null/blank cuando no aplica. */
            String comentarios
    ) {
    }
}
