package ar.com.leo.showroom.showroom.dto;

import java.math.BigDecimal;

public record PedidoItemDTO(
        String sku,
        String descripcion,
        Integer cantidad,
        /** Precio unitario CON IVA — el que se envió a DUX. */
        BigDecimal precioUnitario,
        /** PVP de lista CON IVA, ANTES de aplicar la forma de pago (a diferencia de
         *  {@code precioUnitario}, que es el precio final post-forma). Lo necesita
         *  el flujo de edición de pedido para no re-aplicar el recargo de la forma.
         *  Null en pedidos anteriores a esta columna. */
        BigDecimal precioListaConIva,
        /** % de IVA aplicado en el momento del pedido. Null para pedidos viejos. */
        BigDecimal porcIva,
        /** Si el {@code precioUnitario} lleva IVA (lo decide el perfil del rubro
         *  del ítem). Null para pedidos anteriores a esta columna → el frontend
         *  cae al flag global {@code formaPagoAplicaIva}. */
        Boolean aplicaIva,
        /** % de descuento de la línea (lo que se mandó a DUX como porc_desc). El
         *  {@code precioUnitario} es BRUTO; el frontend deriva el subtotal neto
         *  aplicando este %. Null = sin descuento (incluye pedidos viejos). */
        BigDecimal descuentoPorcentaje,
        /** URL del endpoint local que sirve la imagen del producto, o null si no
         *  hay archivo. Se calcula al leer el pedido (no se persiste con el item). */
        String imagenUrl,
        /** Comentarios libres que viajaron como {@code comentarios} de la línea
         *  al payload DUX. Usado para describir productos genéricos cargados
         *  con el SKU comodín. Null en líneas de producto del catálogo. */
        String comentarios,
        /** Rubro DUX del producto (snapshot del pedido). Para marcar maquinaria
         *  en la tabla. Null en pedidos anteriores a esta columna. */
        String rubro
) {
}
