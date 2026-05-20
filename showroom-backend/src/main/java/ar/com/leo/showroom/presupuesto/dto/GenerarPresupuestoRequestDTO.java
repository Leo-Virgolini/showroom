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

        /** % efectivo del descuento total sobre el subtotal bruto, calculado
         *  por el frontend como {@code descTotal_$ / subtotalBruto × 100}.
         *  SOLO informativo — los items ya traen sus descuentos individuales
         *  aplicados, NO se reaplica como factor extra (ver feedback del
         *  2026-05-20). Null o 0 = sin descuentos. */
        @PositiveOrZero
        BigDecimal descuentoGlobalPorcentaje,

        /** Modo de cotización individual: cuando es {@code true}, el PDF emite
         *  UNA hoja por cada ítem (con foto grande + formas de pago calculadas
         *  sobre el precio de ESE ítem) y NO genera la hoja agregada con tabla
         *  detalle + total + formas de pago globales. Caso típico: cliente que
         *  pide cotización de varias alternativas (amasadora 20L vs 30L) y
         *  necesita comparar opciones independientes. Null o false = formato
         *  agregado tradicional. */
        Boolean cotizacionIndividual,

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
            @PositiveOrZero BigDecimal descuentoPorcentaje
    ) {}

    public record FormaPagoSnapshot(
            Long id,
            @NotNull String nombre,
            BigDecimal recargoPorcentaje,
            Integer cantidadCuotas,
            Boolean aplicaIva,
            /** Precio FINAL que el cliente paga con esta forma — el frontend
             *  lo calcula y se lo pasa al backend para que aparezca tal cual
             *  en el PDF (evita doble cálculo y discrepancias).
             *
             *  En modo {@code cotizacionIndividual}, el frontend manda N×M
             *  snapshots (N formas × M items) y este precioFinal corresponde
             *  al precio de la forma sobre el ítem identificado por {@link #itemSku}. */
            @NotNull BigDecimal precioFinal,
            /** Texto descriptivo opcional ("3 cuotas sin interés", "26% off con remito"...). */
            String descripcion,
            /** Si la forma se factura en USD/otra moneda — solo informativo
             *  para mostrar "USD" en vez de "$". */
            String monedaSimbolo,
            /** SKU del ítem al que corresponde este snapshot en modo
             *  {@code cotizacionIndividual}. Null cuando es global (todos los
             *  ítems sumados). */
            String itemSku
    ) {}
}
