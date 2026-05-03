package ar.com.leo.showroom.showroom.dto;

import java.math.BigDecimal;

public record PedidoItemDTO(
        String sku,
        String descripcion,
        Integer cantidad,
        /** Precio unitario CON IVA — el que se envió a DUX. */
        BigDecimal precioUnitario,
        /** % de IVA aplicado en el momento del pedido. Null para pedidos viejos. */
        BigDecimal porcIva,
        /** URL del endpoint local que sirve la imagen del producto, o null si no
         *  hay archivo. Se calcula al leer el pedido (no se persiste con el item). */
        String imagenUrl
) {
}
