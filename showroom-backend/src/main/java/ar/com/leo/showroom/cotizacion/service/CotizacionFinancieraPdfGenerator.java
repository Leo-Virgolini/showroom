package ar.com.leo.showroom.cotizacion.service;

import ar.com.leo.showroom.cotizacion.dto.GenerarCotizacionRequestDTO;
import ar.com.leo.showroom.cotizacion.entity.CotizacionFinanciera;
import com.itextpdf.io.image.ImageData;
import com.itextpdf.io.image.ImageDataFactory;
import com.itextpdf.kernel.colors.Color;
import com.itextpdf.kernel.colors.ColorConstants;
import com.itextpdf.kernel.colors.DeviceRgb;
import com.itextpdf.kernel.geom.PageSize;
import com.itextpdf.kernel.geom.Rectangle;
import com.itextpdf.kernel.pdf.PdfDocument;
import com.itextpdf.kernel.pdf.PdfPage;
import com.itextpdf.kernel.pdf.PdfWriter;
import com.itextpdf.kernel.pdf.canvas.PdfCanvas;
import com.itextpdf.kernel.pdf.event.AbstractPdfDocumentEventHandler;
import com.itextpdf.kernel.pdf.event.PdfDocumentEvent;
import com.itextpdf.layout.Canvas;
import com.itextpdf.layout.Document;
import com.itextpdf.layout.borders.Border;
import com.itextpdf.layout.borders.SolidBorder;
import com.itextpdf.layout.element.Cell;
import com.itextpdf.layout.element.Div;
import com.itextpdf.layout.element.Image;
import com.itextpdf.layout.element.Paragraph;
import com.itextpdf.layout.element.Table;
import com.itextpdf.layout.properties.BorderRadius;
import com.itextpdf.layout.properties.HorizontalAlignment;
import com.itextpdf.layout.properties.TextAlignment;
import com.itextpdf.layout.properties.UnitValue;
import com.itextpdf.layout.properties.VerticalAlignment;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.io.ByteArrayOutputStream;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.text.NumberFormat;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.Locale;
import java.util.Optional;

/**
 * Genera el PDF de la cotización financiera — una sola hoja con el monto
 * base destacado y la lista de formas de pago calculadas. Versión
 * minimalista del layout que usa {@code PresupuestoComercialPdfGenerator},
 * sin items, sin descuentos por línea, sin tablas — todo en cards.
 *
 * <p>Estructura (A4):
 * <ol>
 *   <li>Header marrón con "COTIZACIÓN FINANCIERA #N" + fecha.</li>
 *   <li>Card del cliente: nombre + fecha y hora.</li>
 *   <li>Banner con el MONTO BASE destacado (sin IVA).</li>
 *   <li>Cards de formas de pago con su precio final cada una.</li>
 *   <li>Observaciones (opcional).</li>
 *   <li>Footer con logo chico + "Página X".</li>
 * </ol>
 */
@Slf4j
@Component
public class CotizacionFinancieraPdfGenerator {

    private static final Color KT_NARANJA = new DeviceRgb(255, 134, 28);
    private static final Color KT_MARRON = new DeviceRgb(59, 30, 9);
    private static final Color KT_VERDE = new DeviceRgb(126, 186, 0);
    private static final Color GRIS_OSCURO = new DeviceRgb(45, 45, 45);
    private static final Color GRIS_MEDIO = new DeviceRgb(110, 110, 110);
    private static final Color GRIS_LINEA = new DeviceRgb(225, 225, 230);

    /** Mismos colores que las cards de formas de pago en el presupuesto —
     *  sincronizado con .color-1..10 en el frontend. */
    private static final Color[] BORDE_FORMA_PAGO = new Color[]{
            new DeviceRgb(234, 179, 8),     // amarillo
            new DeviceRgb(59, 130, 246),    // azul
            new DeviceRgb(16, 185, 129),    // verde esmeralda
            new DeviceRgb(249, 115, 22),    // naranja
            new DeviceRgb(168, 85, 247),    // púrpura
            new DeviceRgb(236, 72, 153),    // rosa
            new DeviceRgb(6, 182, 212),     // cian
            new DeviceRgb(132, 204, 22),    // lima
            new DeviceRgb(99, 102, 241),    // índigo
            new DeviceRgb(217, 119, 6),     // ámbar oscuro
    };

    private static final ZoneId TZ_AR = ZoneId.of("America/Argentina/Buenos_Aires");
    private static final DateTimeFormatter FECHA_HORA_FMT = DateTimeFormatter.ofPattern("dd/MM/yyyy HH:mm");
    private static final NumberFormat PESO_FMT = NumberFormat.getCurrencyInstance(Locale.of("es", "AR"));
    static {
        PESO_FMT.setMaximumFractionDigits(0);
        PESO_FMT.setMinimumFractionDigits(0);
    }

    public byte[] generar(CotizacionFinanciera cotizacion, GenerarCotizacionRequestDTO datos) {
        try (ByteArrayOutputStream out = new ByteArrayOutputStream();
             PdfWriter writer = new PdfWriter(out);
             PdfDocument pdfDoc = new PdfDocument(writer);
             Document doc = new Document(pdfDoc, PageSize.A4)) {

            doc.setMargins(30, 30, 40, 30);

            ImageData logoHeader = cargarRecurso("/images/kt-gastro-logo.png");
            ImageData logoFooter = cargarRecurso("/images/logoKT.png");
            pdfDoc.addEventHandler(PdfDocumentEvent.END_PAGE,
                    new FooterHandler(pdfDoc, logoFooter));

            agregarHeader(doc, cotizacion, logoHeader);
            agregarCardCliente(doc, cotizacion);
            agregarBannerMonto(doc, datos);
            agregarFormasPago(doc, datos.formasPago());
            agregarNotas(doc);
            if (datos.observaciones() != null && !datos.observaciones().isBlank()) {
                agregarObservaciones(doc, datos);
            }

            doc.close();
            return out.toByteArray();
        } catch (Exception e) {
            log.error("Error generando PDF de cotización {}: {}",
                    cotizacion.getId(), e.getMessage(), e);
            throw new RuntimeException("Error generando PDF de cotización", e);
        }
    }

    /** Filename: cotizacion-{cliente}-N{id}-ddMMyyyy.pdf. */
    public String nombreArchivo(CotizacionFinanciera cotizacion) {
        String cliente = sanitizar(Optional.ofNullable(cotizacion.getClienteNombre()).orElse(""));
        String fecha = cotizacion.getCreadoAt() != null
                ? cotizacion.getCreadoAt().atZone(TZ_AR).toLocalDate()
                        .format(DateTimeFormatter.ofPattern("ddMMyyyy"))
                : "";
        String numero = cotizacion.getId() != null
                ? "N" + cotizacion.getId()
                : "borrador";
        return "cotizacion-" + cliente + "-" + numero
                + (fecha.isEmpty() ? "" : "-" + fecha) + ".pdf";
    }

    // =====================================================
    // Header marrón con logo + número de cotización
    // =====================================================
    private void agregarHeader(Document doc, CotizacionFinanciera c, ImageData logoHeader) {
        Div headerWrapper = new Div()
                .setBackgroundColor(KT_MARRON)
                .setBorderRadius(new BorderRadius(10f))
                .setPadding(12)
                .setMarginBottom(2);

        Table grid = new Table(UnitValue.createPercentArray(new float[]{2.2f, 1.5f}))
                .useAllAvailableWidth()
                .setBorder(Border.NO_BORDER);

        // Columna izquierda: logo KT.
        Cell celdaLogo = new Cell()
                .setBorder(Border.NO_BORDER)
                .setVerticalAlignment(VerticalAlignment.MIDDLE)
                .setPadding(0);
        if (logoHeader != null) {
            Image logo = new Image(logoHeader).setHeight(40);
            celdaLogo.add(logo);
        }
        grid.addCell(celdaLogo);

        // Columna derecha: título "COTIZACIÓN FINANCIERA" + número.
        Cell celdaTitulo = new Cell()
                .setBorder(Border.NO_BORDER)
                .setVerticalAlignment(VerticalAlignment.MIDDLE)
                .setTextAlignment(TextAlignment.RIGHT)
                .setPadding(0);
        celdaTitulo.add(new Paragraph("COTIZACIÓN FINANCIERA")
                .simulateBold()
                .setFontSize(13)
                .setCharacterSpacing(1.5f)
                .setFontColor(KT_NARANJA)
                .setMargin(0));
        if (c.getId() != null) {
            celdaTitulo.add(new Paragraph("# " + c.getId())
                    .simulateBold()
                    .setFontSize(22)
                    .setFontColor(ColorConstants.WHITE)
                    .setMarginTop(2)
                    .setMargin(0));
        }
        celdaTitulo.add(new Paragraph("Precios sujetos a modificación")
                .setFontSize(8)
                .setFontColor(new DeviceRgb(200, 180, 160))
                .setMarginTop(2)
                .setMargin(0));
        grid.addCell(celdaTitulo);

        headerWrapper.add(grid);
        doc.add(headerWrapper);
    }

    // =====================================================
    // Card del cliente
    // =====================================================
    private void agregarCardCliente(Document doc, CotizacionFinanciera c) {
        Div card = new Div()
                .setMarginTop(4)
                .setBackgroundColor(ColorConstants.WHITE)
                .setBorder(new SolidBorder(GRIS_LINEA, 1f))
                .setBorderRadius(new BorderRadius(10f))
                .setPadding(6);

        Table grid = new Table(UnitValue.createPercentArray(new float[]{1.8f, 1f}))
                .useAllAvailableWidth()
                .setBorder(Border.NO_BORDER);

        // Columna 1: nombre del cliente.
        Cell celdaCliente = new Cell()
                .setBorder(Border.NO_BORDER)
                .setVerticalAlignment(VerticalAlignment.MIDDLE)
                .setPadding(2);
        celdaCliente.add(labelChico("CLIENTE"));
        celdaCliente.add(new Paragraph(safe(c.getClienteNombre(), "—"))
                .simulateBold()
                .setFontSize(11)
                .setFontColor(GRIS_OSCURO)
                .setMargin(0));
        grid.addCell(celdaCliente);

        // Columna 2: fecha (con "ACTUALIZADO" si fue editado).
        Cell celdaMeta = new Cell()
                .setBorder(Border.NO_BORDER)
                .setVerticalAlignment(VerticalAlignment.MIDDLE)
                .setPadding(2);
        boolean fueEditado = c.getModificadoAt() != null;
        celdaMeta.add(labelChico(fueEditado ? "ACTUALIZADO" : "FECHA Y HORA"));
        var fechaPrincipal = fueEditado ? c.getModificadoAt() : c.getCreadoAt();
        String fechaHora = fechaPrincipal != null
                ? fechaPrincipal.atZone(TZ_AR).format(FECHA_HORA_FMT)
                : "";
        celdaMeta.add(new Paragraph(fechaHora)
                .simulateBold()
                .setFontSize(11)
                .setFontColor(GRIS_OSCURO)
                .setMargin(0));
        if (fueEditado && c.getCreadoAt() != null) {
            celdaMeta.add(new Paragraph("Emitido " + c.getCreadoAt().atZone(TZ_AR).format(FECHA_HORA_FMT))
                    .setFontSize(7.5f)
                    .setFontColor(GRIS_LINEA)
                    .setMargin(0));
        }
        grid.addCell(celdaMeta);

        card.add(grid);
        doc.add(card);
    }

    // =====================================================
    // Banner grande con el monto base
    // =====================================================
    private void agregarBannerMonto(Document doc, GenerarCotizacionRequestDTO datos) {
        // Banner del monto compactado (padding 10 vs 14, font 26 vs 30) —
        // gana espacio vertical para que las 8 cards + nota entren en una
        // sola hoja A4.
        Div banner = new Div()
                .setMarginTop(8)
                .setBackgroundColor(new DeviceRgb(254, 243, 226)) // crema claro KT
                .setBorder(new SolidBorder(KT_NARANJA, 1.5f))
                .setBorderRadius(new BorderRadius(10f))
                .setPadding(10);

        banner.add(new Paragraph("MONTO A COTIZAR")
                .simulateBold()
                .setFontSize(10)
                .setCharacterSpacing(1.5f)
                .setFontColor(KT_MARRON)
                .setTextAlignment(TextAlignment.CENTER)
                .setMargin(0));

        BigDecimal monto = datos.montoBaseSinIva() == null
                ? BigDecimal.ZERO : datos.montoBaseSinIva();
        banner.add(new Paragraph(PESO_FMT.format(monto))
                .simulateBold()
                .setFontSize(26)
                .setFontColor(KT_NARANJA)
                .setTextAlignment(TextAlignment.CENTER)
                .setMarginTop(2)
                .setMargin(0));

        BigDecimal iva = datos.porcIva() == null ? BigDecimal.valueOf(21) : datos.porcIva();
        banner.add(new Paragraph("precio sin IVA · IVA " + iva.stripTrailingZeros().toPlainString() + "%")
                .setFontSize(9)
                .setFontColor(GRIS_MEDIO)
                .setTextAlignment(TextAlignment.CENTER)
                .setMargin(0));

        doc.add(banner);
    }

    // =====================================================
    // Cards de formas de pago — grilla 2 columnas. Cada card es una tabla
    // interna (header con nombre + chip IVA + badge mejor precio; precio
    // grande; detalle de cuotas) para que el layout sea predecible.
    // =====================================================
    private void agregarFormasPago(Document doc,
                                   List<GenerarCotizacionRequestDTO.FormaPagoSnapshot> formas) {
        if (formas == null || formas.isEmpty()) return;

        doc.add(new Paragraph("FORMAS DE PAGO DISPONIBLES")
                .simulateBold()
                .setFontSize(10)
                .setCharacterSpacing(1.5f)
                .setFontColor(KT_MARRON)
                .setMarginTop(10)
                .setMarginBottom(4)
                .setMargin(0));

        int idxMejor = calcularIndiceMejorPrecio(formas);

        Table grid = new Table(UnitValue.createPercentArray(new float[]{1f, 1f}))
                .useAllAvailableWidth()
                .setBorder(Border.NO_BORDER);

        for (int i = 0; i < formas.size(); i++) {
            GenerarCotizacionRequestDTO.FormaPagoSnapshot f = formas.get(i);
            Color borde = BORDE_FORMA_PAGO[i % BORDE_FORMA_PAGO.length];
            boolean esMejor = i == idxMejor;

            // Padding reducido del wrapper (3 vs 4 antes) — junto con la
            // compresión interna de la card, libera espacio vertical para
            // que la nota final entre en la misma página A4.
            Cell wrapper = new Cell()
                    .setBorder(Border.NO_BORDER)
                    .setPadding(3);
            wrapper.add(construirCardForma(f, borde, esMejor));
            grid.addCell(wrapper);
        }

        // Si la lista es impar, agregamos una celda vacía para que la última
        // card no quede expandida en todo el ancho.
        if (formas.size() % 2 == 1) {
            grid.addCell(new Cell().setBorder(Border.NO_BORDER));
        }

        doc.add(grid);
    }

    /** Construye una card de forma de pago — layout:
     *  <ol>
     *    <li>Top accent bar de color (verde grueso si es mejor precio).</li>
     *    <li>Header: nombre a la izquierda, badge "MEJOR PRECIO" (si aplica)
     *        + chip IVA apilados a la derecha (mini-tables con ancho fijo
     *        para que el border-radius no se renderice como elipse).</li>
     *    <li>Precio final grande, centrado (verde si mejor).</li>
     *    <li>Línea de detalle: "N cuotas de $valor" si hay cuotas, o
     *        "X% de descuento" si la forma tiene recargo negativo.</li>
     *  </ol>
     */
    private Div construirCardForma(GenerarCotizacionRequestDTO.FormaPagoSnapshot f,
                                   Color borde,
                                   boolean esMejor) {
        // Card base. bg verde tenue + borde verde grueso cuando es mejor.
        // Padding total más compacto para que las 8 cards + la nota entren
        // en una sola hoja A4.
        Div card = new Div()
                .setBackgroundColor(esMejor ? new DeviceRgb(240, 253, 244) : ColorConstants.WHITE)
                .setBorder(esMejor ? new SolidBorder(KT_VERDE, 1.5f) : new SolidBorder(GRIS_LINEA, 1f))
                .setBorderRadius(new BorderRadius(8f))
                .setPaddingTop(0)
                .setPaddingBottom(8)
                .setPaddingLeft(0)
                .setPaddingRight(0);

        // Top accent bar — siempre con el color rotativo único de la forma
        // (sincronizado con .color-1..10 del frontend). Antes pisábamos por
        // verde KT cuando era mejor precio, pero eso eliminaba la identidad
        // de color de esa forma. La distinción de "mejor precio" ya está
        // dada por: borde verde grueso de la card + badge "✓ MEJOR PRECIO"
        // + precio en verde, así que la barra puede mantener su color
        // único. Bordes superiores redondeados para seguir el contorno
        // curvo de la card.
        Div barra = new Div()
                .setBackgroundColor(borde)
                .setHeight(4)
                .setBorderTopLeftRadius(new BorderRadius(7f))
                .setBorderTopRightRadius(new BorderRadius(7f));
        card.add(barra);

        // Header table: nombre a la izq, chips/badge a la der.
        Table header = new Table(UnitValue.createPercentArray(new float[]{1.4f, 1f}))
                .useAllAvailableWidth()
                .setBorder(Border.NO_BORDER)
                .setMarginTop(6)
                .setMarginLeft(8)
                .setMarginRight(8);

        // Col 1: nombre.
        Cell celdaNombre = new Cell()
                .setBorder(Border.NO_BORDER)
                .setPadding(0)
                .setVerticalAlignment(VerticalAlignment.TOP);
        celdaNombre.add(new Paragraph(safe(f.nombre(), "—"))
                .simulateBold()
                .setFontSize(10.5f)
                .setFontColor(KT_MARRON)
                .setMargin(0));
        header.addCell(celdaNombre);

        // Col 2: contenedor de chips apilados a la derecha. SIEMPRE reservamos
        // el espacio del badge "MEJOR PRECIO" con un placeholder transparente
        // del mismo tamaño cuando la card NO es la mejor. Sin esto, la card
        // "mejor" sería más alta que las otras y el grid se ve desalineado.
        Cell celdaChips = new Cell()
                .setBorder(Border.NO_BORDER)
                .setPadding(0)
                .setVerticalAlignment(VerticalAlignment.TOP);
        if (esMejor) {
            celdaChips.add(chipPill("✓ MEJOR PRECIO", ColorConstants.WHITE, KT_VERDE)
                    .setMarginBottom(3));
        } else {
            // Placeholder invisible para reservar la misma altura que el badge:
            // mini-tabla de mismo width/padding pero con bg transparente y
            // texto invisible (color = white sobre fondo white).
            celdaChips.add(chipPill("✓ MEJOR PRECIO", ColorConstants.WHITE, ColorConstants.WHITE)
                    .setMarginBottom(3));
        }
        boolean aplicaIva = f.aplicaIva() == null || f.aplicaIva();
        Color chipBg = aplicaIva ? new DeviceRgb(255, 234, 209) : new DeviceRgb(235, 235, 240);
        Color chipFg = aplicaIva ? new DeviceRgb(180, 83, 9) : new DeviceRgb(80, 80, 90);
        celdaChips.add(chipPill(aplicaIva ? "CON IVA" : "SIN IVA", chipFg, chipBg));
        header.addCell(celdaChips);
        card.add(header);

        // Precio final destacado — centrado, jerarquía dominante.
        String simboloMoneda = f.monedaSimbolo() != null && !f.monedaSimbolo().isBlank()
                ? f.monedaSimbolo() + " "
                : "";
        BigDecimal precio = f.precioFinal() == null ? BigDecimal.ZERO : f.precioFinal();
        card.add(new Paragraph(simboloMoneda + PESO_FMT.format(precio))
                .simulateBold()
                .setFontSize(19)
                .setFontColor(esMejor ? KT_VERDE : KT_MARRON)
                .setTextAlignment(TextAlignment.CENTER)
                .setMargin(0)
                .setMarginTop(6)
                .setMarginLeft(8)
                .setMarginRight(8));

        // Línea de detalle: "N cuotas de $valor" si aplica, o descuento por
        // contado si la forma trae recargo negativo. Centrado debajo del precio.
        Integer cuotas = f.cantidadCuotas();
        boolean hayCuotas = cuotas != null && cuotas > 1;
        String detalleTexto;
        boolean detalleEsDescuento = false;
        if (hayCuotas) {
            BigDecimal valorCuota = precio.divide(BigDecimal.valueOf(cuotas),
                    2, RoundingMode.HALF_UP);
            detalleTexto = cuotas + " cuotas de " + PESO_FMT.format(valorCuota);
        } else if (f.recargoPorcentaje() != null && f.recargoPorcentaje().signum() < 0) {
            detalleTexto = f.recargoPorcentaje().abs().stripTrailingZeros().toPlainString()
                    + "% de descuento";
            detalleEsDescuento = true;
        } else {
            detalleTexto = "pago único";
        }
        Paragraph detalle = new Paragraph(detalleTexto)
                .setFontSize(8.5f)
                .setFontColor(detalleEsDescuento ? KT_VERDE : GRIS_MEDIO)
                .setTextAlignment(TextAlignment.CENTER)
                .setMargin(0)
                .setMarginTop(3)
                .setMarginLeft(8)
                .setMarginRight(8);
        if (detalleEsDescuento) detalle.simulateBold();
        card.add(detalle);

        return card;
    }

    /** Helper: chip tipo "pill" con texto centrado, bg color y border-radius
     *  acotado. Se implementa como mini-tabla 1x1 con ancho fijo para evitar
     *  el bug de iText donde {@code setBackgroundColor + setBorderRadius(999)}
     *  sobre un {@code Paragraph} renderiza una elipse demasiado ancha al
     *  expandirse al ancho del padre. La tabla de 1 columna respeta
     *  {@code setWidth} y el border-radius se aplica al borde real del Cell. */
    private Table chipPill(String texto, Color fg, Color bg) {
        Table chip = new Table(1).setBorder(Border.NO_BORDER);
        // Width auto-ajustado al contenido: estimamos ~3.6pt por carácter en
        // 7pt bold + 8pt de padding. Para "✓ MEJOR PRECIO" (~14 chars) da
        // ~58pt; para "CON IVA" (~7 chars) ~33pt. Da chips compactos sin
        // verse estirados como elipses.
        float ancho = Math.min(80, Math.max(36, texto.length() * 3.8f + 8));
        chip.setWidth(ancho);
        chip.setHorizontalAlignment(HorizontalAlignment.RIGHT);
        Cell c = new Cell()
                .setBorder(Border.NO_BORDER)
                .setBackgroundColor(bg)
                .setBorderRadius(new BorderRadius(3f))
                .setPadding(2)
                .setTextAlignment(TextAlignment.CENTER);
        c.add(new Paragraph(texto)
                .simulateBold()
                .setFontSize(7)
                .setCharacterSpacing(0.5f)
                .setFontColor(fg)
                .setMargin(0));
        chip.addCell(c);
        return chip;
    }

    /** Índice de la forma con menor precio final (ignorando las que están en
     *  moneda extranjera). -1 si no hay clara ganadora — empate o todas en
     *  moneda extranjera. */
    private int calcularIndiceMejorPrecio(List<GenerarCotizacionRequestDTO.FormaPagoSnapshot> formas) {
        if (formas.size() <= 1) return -1;
        int idx = -1;
        BigDecimal min = null;
        for (int i = 0; i < formas.size(); i++) {
            GenerarCotizacionRequestDTO.FormaPagoSnapshot f = formas.get(i);
            if (f.precioFinal() == null || f.precioFinal().signum() <= 0) continue;
            if (f.monedaSimbolo() != null && !f.monedaSimbolo().isBlank()) continue;
            if (min == null || f.precioFinal().compareTo(min) < 0) {
                min = f.precioFinal();
                idx = i;
            }
        }
        if (idx < 0 || min == null) return -1;
        // Empate → no resaltamos a nadie.
        final BigDecimal minF = min;
        long empates = formas.stream()
                .filter(f -> minF.equals(f.precioFinal())
                        && (f.monedaSimbolo() == null || f.monedaSimbolo().isBlank()))
                .count();
        return empates > 1 ? -1 : idx;
    }

    /** Descripción comercial — coherente con la lógica del frontend. NO
     *  mostramos "X% de recargo" porque confunde al cliente (% sobre el
     *  efectivo no se entiende intuitivamente); sí mostramos cuotas y
     *  descuentos. */
    private String descripcionForma(GenerarCotizacionRequestDTO.FormaPagoSnapshot f) {
        StringBuilder sb = new StringBuilder();
        BigDecimal recargo = f.recargoPorcentaje();
        if (recargo != null && recargo.signum() < 0) {
            sb.append(recargo.abs().stripTrailingZeros().toPlainString()).append("% de descuento");
        }
        Integer cuotas = f.cantidadCuotas();
        if (cuotas != null && cuotas > 1) {
            if (sb.length() > 0) sb.append(" · ");
            sb.append(cuotas).append(" cuotas");
        }
        return sb.toString();
    }

    private void agregarNotas(Document doc) {
        // Nota final con setKeepTogether para que iText NO la corte entre
        // páginas — si no entra completa en la actual, mueve el bloque
        // entero a la siguiente. Es chica (2 líneas en A4), así que casi
        // siempre cabe junto a las cards.
        Paragraph nota = new Paragraph()
                .add(new com.itextpdf.layout.element.Text("Nota: ").simulateBold())
                .add("Los precios pueden variar sin previo aviso. La cotización es referencial " +
                        "y se confirma al momento de la operación. Las formas con cuotas pueden " +
                        "estar sujetas a aprobación crediticia.")
                .setFontSize(7.5f)
                .setFontColor(GRIS_MEDIO)
                .setMarginTop(6)
                .setMargin(0)
                .setKeepTogether(true);
        doc.add(nota);
    }

    private void agregarObservaciones(Document doc, GenerarCotizacionRequestDTO datos) {
        if (datos.observaciones() == null || datos.observaciones().isBlank()) return;
        Div card = new Div()
                .setMarginTop(8)
                .setBackgroundColor(new DeviceRgb(255, 250, 240))
                .setBorder(new SolidBorder(GRIS_LINEA, 1f))
                .setBorderRadius(new BorderRadius(8f))
                .setPadding(8);
        card.add(labelChico("OBSERVACIONES"));
        card.add(new Paragraph(datos.observaciones())
                .setFontSize(9.5f)
                .setFontColor(GRIS_OSCURO)
                .setMarginTop(2)
                .setMargin(0));
        doc.add(card);
    }

    // =====================================================
    // Helpers
    // =====================================================
    private Paragraph labelChico(String texto) {
        return new Paragraph(texto)
                .simulateBold()
                .setFontSize(7)
                .setCharacterSpacing(1.2f)
                .setFontColor(GRIS_MEDIO)
                .setMargin(0);
    }

    private static String safe(String s, String fallback) {
        return s == null || s.isBlank() ? fallback : s;
    }

    /** Sanitiza un string para usarlo como parte del filename. */
    private static String sanitizar(String s) {
        if (s == null) return "";
        return s.trim()
                .replaceAll("[\\\\/:*?\"<>|]", "")
                .replaceAll("\\s+", "-")
                .toLowerCase(Locale.of("es", "AR"));
    }

    private static ImageData cargarRecurso(String path) {
        try {
            var stream = CotizacionFinancieraPdfGenerator.class.getResourceAsStream(path);
            if (stream == null) return null;
            return ImageDataFactory.create(stream.readAllBytes());
        } catch (Exception e) {
            log.warn("No se pudo cargar recurso {}: {}", path, e.getMessage());
            return null;
        }
    }

    /** Footer minimalista con número de página + logo chico. */
    private static class FooterHandler extends AbstractPdfDocumentEventHandler {
        private final PdfDocument doc;
        private final ImageData logo;

        FooterHandler(PdfDocument doc, ImageData logo) {
            this.doc = doc;
            this.logo = logo;
        }

        @Override
        protected void onAcceptedEvent(com.itextpdf.kernel.pdf.event.AbstractPdfDocumentEvent event) {
            PdfDocumentEvent docEvent = (PdfDocumentEvent) event;
            PdfPage page = docEvent.getPage();
            Rectangle area = page.getPageSize();
            try (Canvas canvas = new Canvas(new PdfCanvas(page), area)) {
                int n = doc.getPageNumber(page);
                int total = doc.getNumberOfPages();
                if (logo != null) {
                    canvas.add(new Image(logo)
                            .setHeight(14)
                            .setFixedPosition(30, 20));
                }
                canvas.add(new Paragraph("Página " + n + " de " + total)
                        .setFontSize(7.5f)
                        .setFontColor(GRIS_MEDIO)
                        .setTextAlignment(TextAlignment.RIGHT)
                        .setFixedPosition(area.getWidth() - 100, 22, 70));
            }
        }
    }
}
