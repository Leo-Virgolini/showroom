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
        /** Si el {@code precioUnitario} lleva IVA (lo decide el perfil del rubro
         *  del ítem). Null para pedidos anteriores a esta columna → el frontend
         *  cae al flag global {@code formaPagoAplicaIva}. */
        Boolean aplicaIva,
        /** URL del endpoint local que sirve la imagen del producto, o null si no
         *  hay archivo. Se calcula al leer el pedido (no se persiste con el item). */
        String imagenUrl,
        /** Comentarios libres que viajaron como {@code comentarios} de la línea
         *  al payload DUX. Usado para describir productos genéricos cargados
         *  con el SKU comodín. Null en líneas de producto del catálogo. */
        String comentarios
) {
}
