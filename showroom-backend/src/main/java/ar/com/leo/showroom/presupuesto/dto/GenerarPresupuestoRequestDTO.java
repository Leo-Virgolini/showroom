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
        /** Rubro comercial del cliente (bar, restaurant, etc.) — string libre.
         *  El frontend valida las opciones predefinidas; cuando el operador
         *  elige "Otros" puede tipear el rubro como texto libre. Null = no
         *  completado. */
        String rubro,
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
            /** Rubro DUX del producto al momento de armar el presupuesto. Lo
             *  usa el PDF de "ítems de interés" para omitir las columnas de
             *  descuento por escala en rubros excluidos (MAQUINAS INDUSTRIALES).
             *  Null = rubro desconocido → se aplican todos los escalones. */
            String rubro,
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
            /** Texto libre que viaja como {@code comentarios} a DUX al
             *  convertir el presupuesto en pedido. Se usa principalmente para
             *  el SKU comodín (ver {@code dux.sku-producto-generico}) cuando
             *  el operador carga un producto que no está en catálogo: la
             *  línea va a DUX con el SKU genérico y los comentarios describen
             *  el producto real. Null/blank cuando no aplica. */
            String comentarios,
            /** Precio unitario con la forma de pago Efectivo (la forma primaria
             *  de referencia), ya resuelto según el rubro del ítem (c/IVA para
             *  menaje, s/IVA para maquinaria). Es lo que se muestra como
             *  "precio del producto" en el PDF/historial y la base de los
             *  totales efectivos. Null en presupuestos viejos generados antes
             *  de este campo → el backend cae al precio de lista según rubro. */
            BigDecimal precioEfectivo
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
            String itemSku,
            /** Recargo del perfil maquinaria de la forma (nullable → 0, no hereda
             *  del perfil menaje). Necesario para recalcular per-rubro al cambiar
             *  el modo de cotización. Null en presupuestos anteriores a esta
             *  versión → se cae al perfil menaje. */
            BigDecimal recargoPorcentajeMaquinaria,
            /** aplicaIva del perfil maquinaria (nullable → false). */
            Boolean aplicaIvaMaquinaria
    ) {}
}
