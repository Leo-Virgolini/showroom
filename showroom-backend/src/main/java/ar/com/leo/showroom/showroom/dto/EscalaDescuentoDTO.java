package ar.com.leo.showroom.showroom.dto;

import java.math.BigDecimal;

/**
 * Escalón de descuento expuesto al frontend. {@code umbralMin} es el subtotal
 * SIN IVA (pesos) a partir del cual se aplica {@code porcentaje} sobre el
 * carrito completo.
 */
public record EscalaDescuentoDTO(
        BigDecimal umbralMin,
        BigDecimal porcentaje
) {
}
