package ar.com.leo.showroom.showroom.dto;

import java.util.List;

/**
 * Snapshot agregado para los charts y KPIs de la pantalla de historial.
 *
 * @param topEscaneados      productos más frecuentemente escaneados (sin importar
 *                           si terminaron en pedido). Refleja interés del cliente.
 * @param topComprados       productos con mayor cantidad vendida en pedidos no
 *                           anulados. Refleja conversión real.
 * @param tasaConversion     KPI global del showroom: cuántas sesiones terminaron
 *                           en pedido sobre el total de sesiones finalizadas.
 * @param topConversion      productos ordenados por % de conversión descendente
 *                           (los que más cierran venta cuando se escanean).
 *                           Filtramos los que tienen muy pocos scans para evitar
 *                           ruido (ej: un SKU escaneado 1 vez y comprado 1 vez no
 *                           es informativo).
 */
public record EstadisticasHistorialDTO(
        List<EstadisticaProductoDTO> topEscaneados,
        List<EstadisticaProductoDTO> topComprados,
        TasaConversionGlobalDTO tasaConversion,
        List<ConversionProductoDTO> topConversion
) {
}
