package ar.com.leo.showroom.showroom.dto;

import java.math.BigDecimal;

public record PedidoItemDTO(
        String sku,
        String descripcion,
        Integer cantidad,
        /** Precio unitario CON IVA — el que se envió a DUX. */
        BigDecimal precioUnitario,
        /** % de IVA aplicado en el momento del pedido. Null para pedidos viejos. */
        BigDecimal porcIva
) {
}
