package ar.com.leo.showroom.showroom.dto;

import java.util.List;

/** Datos que el visor (celular, sin login) necesita para renderizar precios,
 *  servidos en una sola llamada token-scoped: formas de pago activas, escalas
 *  de descuento y rubros que cotizan sin IVA. */
public record VisorBootstrapDTO(
        List<FormaPagoDTO> formasPago,
        List<EscalaDescuentoDTO> escalasDescuento,
        List<String> rubrosSinIva
) {}
