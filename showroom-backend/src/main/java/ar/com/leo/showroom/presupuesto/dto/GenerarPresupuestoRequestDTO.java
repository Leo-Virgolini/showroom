package ar.com.leo.showroom.presupuesto.dto;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Positive;
import jakarta.validation.constraints.PositiveOrZero;

import java.math.BigDecimal;
import java.util.List;

/**
 * Payload que manda el frontend desde la pantalla /presupuestos para generar
 * el PDF de presupuesto comercial. Incluye los items elegidos (con su
 * descuento individual), los datos del cliente (todos opcionales excepto en
 * el endpoint de envío por email — el controller valida ahí) y los snapshots
 * de las formas de pago activas con sus precios calculados en el frontend.
 */
public record GenerarPresupuestoRequestDTO(
        String clienteNombre,
        String clienteTelefono,
        String clienteEmail,
        String observaciones,

        /** % de descuento sobre el subtotal (0..100). Se aplica al final,
         *  después de los descuentos individuales por ítem. Null o 0 = sin
         *  descuento global. */
        @PositiveOrZero
        BigDecimal descuentoGlobalPorcentaje,

        @NotEmpty(message = "El presupuesto debe tener al menos un ítem")
        @Valid
        List<Item> items,

        @Valid
        List<FormaPagoSnapshot> formasPago
) {

    public record Item(
            @NotNull String sku,
            String descripcion,
            @NotNull @Positive BigDecimal cantidad,
            /** Precio unitario CON IVA tal como se mostró en la pantalla — el
             *  generador del PDF lo divide por (1 + porcIva/100) para mostrar
             *  s/IVA si hiciera falta, pero el layout principal usa con-IVA. */
            @NotNull @PositiveOrZero BigDecimal precioConIva,
            /** % de IVA del producto (típicamente 21 o 10.5). Si es null se
             *  asume 21 para los cálculos. */
            BigDecimal porcIva,
            /** % de descuento individual aplicado a este ítem (0..100). */
            @PositiveOrZero BigDecimal descuentoPorcentaje,
            /** Índice de alternativa al que pertenece el ítem (0-indexed). Cuando
             *  el operador activa "Separar en alternativas", cada ítem se asigna
             *  a una alternativa y el PDF emite una hoja por cada una con su
             *  propio detalle + formas de pago. Null o 0 = sin separación
             *  (comportamiento histórico). */
            Integer alternativa
    ) {}

    public record FormaPagoSnapshot(
            Long id,
            @NotNull String nombre,
            BigDecimal recargoPorcentaje,
            Integer cantidadCuotas,
            Boolean aplicaIva,
            /** Precio FINAL que el cliente paga con esta forma — el frontend
             *  lo calcula y se lo pasa al backend para que aparezca tal cual
             *  en el PDF (evita doble cálculo y discrepancias). */
            @NotNull BigDecimal precioFinal,
            /** Texto descriptivo opcional ("3 cuotas sin interés", "26% off con remito"...). */
            String descripcion,
            /** Si la forma se factura en USD/otra moneda — solo informativo
             *  para mostrar "USD" en vez de "$". */
            String monedaSimbolo,
            /** Índice de alternativa al que pertenece este snapshot (0-indexed).
             *  Cuando hay alternativas, el frontend manda len(formasPago) *
             *  len(alternativas) snapshots con su precioFinal recalculado por
             *  grupo. Null o 0 cuando no hay separación. */
            Integer alternativa
    ) {}
}
