package ar.com.leo.showroom.picking;

import ar.com.leo.showroom.catalogo.service.ImagenLocalService;
import ar.com.leo.showroom.common.pdf.KtPdfColores;
import ar.com.leo.showroom.common.pdf.PdfFormatoUtils;
import ar.com.leo.showroom.common.util.NombreArchivoUtils;
import ar.com.leo.showroom.common.pdf.PdfImagenReutilizable;
import ar.com.leo.showroom.common.pdf.PdfImagenUtils;
import ar.com.leo.showroom.config.entity.FormaPago;
import ar.com.leo.showroom.config.service.FormaPagoService;
import ar.com.leo.showroom.config.service.PrecioPerfilCalculator;
import ar.com.leo.showroom.pedido.entity.PedidoShowroom;
import ar.com.leo.showroom.pedido.entity.PedidoShowroomItem;
import ar.com.leo.showroom.sesion.entity.SesionScanItem;
import ar.com.leo.showroom.sesion.entity.SesionShowroom;
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
import com.itextpdf.kernel.pdf.WriterProperties;
import com.itextpdf.kernel.pdf.canvas.PdfCanvas;
import com.itextpdf.kernel.pdf.event.AbstractPdfDocumentEvent;
import com.itextpdf.kernel.pdf.event.AbstractPdfDocumentEventHandler;
import com.itextpdf.kernel.pdf.event.PdfDocumentEvent;
import com.itextpdf.layout.Canvas;
import com.itextpdf.layout.Document;
import com.itextpdf.layout.borders.Border;
import com.itextpdf.layout.borders.SolidBorder;
import com.itextpdf.layout.element.AreaBreak;
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
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.List;

/**
 * Genera un PDF de presupuesto con tema KT GASTRO para mandarle al cliente.
 * Estilo portado del java-pdf-catalog-generator existente: mismos colores,
 * backgrounds y footer (logo KT + "Página X" al pie de cada página, omitiendo
 * la portada). Layout: carátula con razón social + fecha + CUIT, y páginas de
 * 4 productos cada una con CÓDIGO | NOMBRE | PRECIO | FOTO (sin
 * valorización total — pedido del cliente).
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class PresupuestoPdfGenerator {

    private static final int PRODUCTOS_POR_PAGINA = 4;

    // Tema KT (colores extraídos de KitchenToolsTheme del catalog generator).
    // Los colores compartidos idénticos viven en KtPdfColores; acá quedan como
    // alias locales para no tocar el cuerpo del generador.
    private static final Color KT_NARANJA = KtPdfColores.KT_NARANJA;
    private static final Color KT_MARRON = KtPdfColores.KT_MARRON;
    private static final Color KT_NARANJA_CODIGO = new DeviceRgb(255, 135, 12);
    private static final Color KT_AZUL_CODIGO_TEXTO = KtPdfColores.KT_AZUL_CODIGO_TEXTO;
    private static final Color GRIS_OSCURO = KtPdfColores.GRIS_OSCURO;
    private static final Color GRIS_CLARO = new DeviceRgb(235, 235, 235);
    /** Gris medio para las líneas separadoras dentro de la card gris (la card
     *  es 235,235,235 — una línea del mismo gris no se vería). Valor propio
     *  de este PDF (200,200,200), distinto del GRIS_LINEA de los otros
     *  generadores — se mantiene local a propósito. */
    private static final Color GRIS_LINEA = new DeviceRgb(200, 200, 200);
    /** Verde profundo para el precio — combina con el verde del logo KT (la
     *  olla alrededor de la K) y contrasta con el naranja del pill SKU. */
    private static final Color VERDE_PRECIO = KtPdfColores.VERDE_PRECIO;

    private static final DateTimeFormatter FECHA_FORMATTER = DateTimeFormatter.ofPattern("dd/MM/yyyy");
    /** TZ del showroom: la fecha del pedido se computa según AR aunque la JVM
     *  corra en UTC (caso típico en cloud). */
    private static final ZoneId TZ_AR = ZoneId.of("America/Argentina/Buenos_Aires");

    private final ImagenLocalService imagenLocalService;
    private final FormaPagoService formaPagoService;
    private final PrecioPerfilCalculator precioPerfilCalculator;

    /**
     * PDF del historial de scans para un pedido: lo que el cliente VIO durante
     * la sesión, EXCLUYENDO lo que realmente compró. Misma portada y mismo
     * layout de items que el presupuesto — solo cambia la lista origen.
     *
     * <p>Usado por el email post-pedido: al cliente le llega el catálogo de
     * "productos vistos pero no comprados" como follow-up.
     *
     * @param sesion sesión asociada al pedido (con scans persistidos).
     * @param pedido pedido en DUX (para la portada: nombre + cuit + fecha).
     * @return null si no quedan items luego de filtrar lo comprado (no hay
     *         qué mandar) — el caller decide si saltea el email.
     */
    public byte[] generarHistorial(SesionShowroom sesion, PedidoShowroom pedido) {
        java.util.Set<String> skusComprados = pedido.getItems().stream()
                .map(PedidoShowroomItem::getSku)
                .filter(java.util.Objects::nonNull)
                .collect(java.util.stream.Collectors.toSet());
        FormaPago destacadaMenaje = formaPagoService.formaDestacada(false);
        FormaPago destacadaMaquinaria = formaPagoService.formaDestacada(true);
        List<ItemView> views = sesion.getItems().stream()
                .filter(it -> !skusComprados.contains(it.getSku()))
                .map(it -> fromSesionItem(it, destacadaMenaje, destacadaMaquinaria))
                .toList();
        if (views.isEmpty()) {
            return null;
        }
        return generarConItems(pedido, views);
    }

    /** Pipeline común: portada con datos del pedido + N páginas con los items. */
    private byte[] generarConItems(PedidoShowroom pedido, List<ItemView> items) {
        try (ByteArrayOutputStream out = new ByteArrayOutputStream();
             PdfWriter writer = new PdfWriter(out, new WriterProperties()
                     .setFullCompressionMode(true).setCompressionLevel(9));
             PdfDocument pdfDoc = new PdfDocument(writer);
             Document doc = new Document(pdfDoc, PageSize.A4)) {

            doc.setMargins(40, 40, 40, 40);

            // Fondo/logo/placeholder reutilizables: cada uno se incrusta UNA sola vez
            // y se reusa en todas las páginas (antes se re-incrustaban por página; con
            // logoKT.png el peso se multiplicaba por la cantidad de hojas del pedido).
            PdfImagenReutilizable bgPortada = PdfImagenReutilizable.of(cargarRecurso("/images/backgroundKT.png"));
            PdfImagenReutilizable bgInterior = PdfImagenReutilizable.of(cargarRecurso("/images/backgroundwhiteKT.png"));
            PdfImagenReutilizable logoKT = PdfImagenReutilizable.of(cargarRecurso("/images/logoKT.png"));
            pdfDoc.addEventHandler(PdfDocumentEvent.START_PAGE, new BackgroundHandler(pdfDoc, bgPortada, bgInterior));
            pdfDoc.addEventHandler(PdfDocumentEvent.END_PAGE, new FooterHandler(pdfDoc, logoKT));

            PdfImagenReutilizable sinImagen = PdfImagenReutilizable.of(cargarRecurso("/images/SINIMAGEN.jpg"));

            // PORTADA
            agregarPortada(doc, pedido, logoKT);

            // PÁGINAS DE PRODUCTOS (4 por página).
            doc.add(new AreaBreak());
            agregarPaginasProductos(doc, items, sinImagen);

            doc.close();
            return out.toByteArray();
        } catch (Exception e) {
            log.error("Error generando PDF para pedido {}: {}", pedido.getId(), e.getMessage(), e);
            throw new RuntimeException("Error generando PDF", e);
        }
    }

    /** Vista de un item para renderizar — solo los campos que necesita el block. */
    private record ItemView(String sku, String descripcion, BigDecimal precioMostrado) {}

    /** Mapea un scan a la vista del PDF calculando el precio con la forma de pago
     *  predefinida (destacada) del perfil del rubro — mismo criterio que el
     *  scan/visor/presupuestador: menaje al precio efectivo (ej. Efectivo c/IVA),
     *  maquinaria s/IVA. Sin forma destacada cae al precio de lista por rubro. */
    private ItemView fromSesionItem(SesionScanItem it, FormaPago destacadaMenaje,
                                    FormaPago destacadaMaquinaria) {
        boolean esMaq = precioPerfilCalculator.esMaquinaria(it.getRubro());
        FormaPago forma = esMaq ? destacadaMaquinaria : destacadaMenaje;
        return new ItemView(it.getSku(), it.getDescripcion(),
                precioMostrado(it.getPrecioConIva(), it.getPorcIva(), forma, esMaq));
    }

    /** Precio a mostrar para un ítem: con la forma destacada y el perfil del rubro
     *  si hay una marcada; si no, precio de lista (maquinaria s/IVA, resto c/IVA). */
    private static BigDecimal precioMostrado(BigDecimal conIva, BigDecimal porcIva,
                                             FormaPago forma, boolean esMaquinaria) {
        if (conIva == null) return null;
        if (forma != null) {
            return PrecioPerfilCalculator.calcularPrecioFinal(conIva, porcIva,
                    PrecioPerfilCalculator.recargoPerfil(forma, esMaquinaria),
                    PrecioPerfilCalculator.aplicaIvaPerfil(forma, esMaquinaria));
        }
        return esMaquinaria ? PrecioPerfilCalculator.calcularSinIva(conIva, porcIva) : conIva;
    }

    public String nombreArchivo(PedidoShowroom pedido) {
        LocalDate fecha = pedido.getCreadoAt() != null
                ? pedido.getCreadoAt().atZone(TZ_AR).toLocalDate()
                : LocalDate.now(TZ_AR);
        String cliente = NombreArchivoUtils.sanitizar(pedido.getNombreCompleto());
        return "presupuesto-" + cliente + "-pedido-" + pedido.getId() + "-"
                + fecha.format(DateTimeFormatter.ofPattern("ddMMyyyy")) + ".pdf";
    }

    // =====================================================
    // PORTADA
    // =====================================================

    private void agregarPortada(Document doc, PedidoShowroom pedido, PdfImagenReutilizable logo) {
        // Logo grande KT (con olla + "KITCHENTOOLS"), igual al catalog generator.
        Image logoImg = null;
        if (logo != null) {
            logoImg = logo.nuevaImagen();
            logoImg.setWidth(300);
            logoImg.setHorizontalAlignment(HorizontalAlignment.CENTER);
            logoImg.setMarginBottom(20);
        }

        // Título: nombre completo del cliente en naranja KT (o "CLIENTE" como fallback).
        String tituloTexto = safe(pedido.getNombreCompleto(), "CLIENTE");
        Paragraph titulo = new Paragraph(tituloTexto)
                .simulateBold()
                .setFontSize(36)
                .setFontColor(KT_NARANJA)
                .setTextAlignment(TextAlignment.CENTER)
                .setPaddingTop(20)
                .setPaddingBottom(20)
                .setMultipliedLeading(0.95f)
                .setMargin(0);

        // Subtítulo: fecha del pedido en marrón KT, bold.
        String fecha = pedido.getCreadoAt() != null
                ? pedido.getCreadoAt().atZone(TZ_AR).toLocalDate().format(FECHA_FORMATTER)
                : LocalDate.now(TZ_AR).format(FECHA_FORMATTER);
        Paragraph subtitulo = new Paragraph(fecha)
                .simulateBold()
                .setFontSize(20)
                .setFontColor(KT_MARRON)
                .setTextAlignment(TextAlignment.CENTER)
                .setPadding(10)
                .setMargin(0);

        final float CARD_WIDTH = 380f;
        Div separador1 = new Div().setWidth(CARD_WIDTH).setHeight(1).setBackgroundColor(GRIS_LINEA);
        Div separador2 = new Div().setWidth(CARD_WIDTH).setHeight(1).setBackgroundColor(GRIS_LINEA);

        // Card portada con bordes redondeados — diseño portado de CardPortadaComponent.
        Div card = new Div()
                .setWidth(CARD_WIDTH)
                .setBackgroundColor(ColorConstants.WHITE)
                .setBorderRadius(new BorderRadius(15f))
                .setBorder(new SolidBorder(GRIS_LINEA, 2f))
                .setHorizontalAlignment(HorizontalAlignment.CENTER)
                .add(new Paragraph("PRODUCTOS DE INTERÉS")
                        .simulateBold()
                        .setPadding(10)
                        .setFontSize(23)
                        .setCharacterSpacing(1)
                        .setFontColor(ColorConstants.LIGHT_GRAY)
                        .setTextAlignment(TextAlignment.CENTER)
                        .setMargin(0))
                .add(separador1)
                .add(titulo)
                .add(separador2)
                .add(subtitulo);

        // Centrar todo verticalmente en la página, mismo patrón que PDFUtils.addFirstPage.
        float pageHeight = PageSize.A4.getHeight();
        float usableHeight = pageHeight - doc.getTopMargin() - doc.getBottomMargin();

        Div portada = new Div()
                .setHeight(usableHeight)
                .setVerticalAlignment(VerticalAlignment.MIDDLE)
                .setTextAlignment(TextAlignment.CENTER);

        if (logoImg != null) portada.add(logoImg);
        portada.add(card);

        // CUIT debajo de la card si está disponible.
        if (pedido.getNroDoc() != null) {
            portada.add(new Paragraph("CUIT: " + pedido.getNroDoc())
                    .setFontSize(11)
                    .setFontColor(KT_MARRON)
                    .setTextAlignment(TextAlignment.CENTER)
                    .setMarginTop(16));
        }

        doc.add(portada);
    }

    // =====================================================
    // PRODUCTOS — 4 por página
    // =====================================================

    private void agregarPaginasProductos(Document doc, List<ItemView> items, PdfImagenReutilizable sinImagen) {
        // Calcular la altura de cada bloque para que entren PRODUCTOS_POR_PAGINA
        // bien distribuidos en el alto útil de la página. Margen extra de ~60pt
        // para separadores entre items y el footer (logo + número de página).
        float pageHeight = PageSize.A4.getHeight();
        float usableHeight = pageHeight - doc.getTopMargin() - doc.getBottomMargin() - 40f;
        float bloqueHeight = usableHeight / PRODUCTOS_POR_PAGINA;

        for (int i = 0; i < items.size(); i++) {
            int posEnPagina = i % PRODUCTOS_POR_PAGINA;

            if (posEnPagina == 0 && i > 0) {
                doc.add(new AreaBreak());
            }

            // Alternar la posición de la imagen según el índice — patrón del catalog
            // generator: pares (0, 2, …) imagen a la izquierda; impares a la derecha.
            boolean imagenIzquierda = (i % 2) == 0;
            Table itemBlock = buildItemBlock(items.get(i), sinImagen, imagenIzquierda, bloqueHeight);
            // Cada bloque entero queda en una sola página (no se parte el producto a la mitad).
            itemBlock.setKeepTogether(true);
            doc.add(itemBlock);

            // Línea separadora entre items dentro de la misma página (delgada y sin margen
            // grande para no robarle alto útil a los bloques).
            if (posEnPagina < PRODUCTOS_POR_PAGINA - 1 && i < items.size() - 1) {
                Div linea = new Div()
                        .setHeight(1)
                        .setMarginTop(2)
                        .setMarginBottom(2)
                        .setBackgroundColor(GRIS_LINEA);
                doc.add(linea);
            }
        }
    }

    private Table buildItemBlock(ItemView it, PdfImagenReutilizable sinImagenData,
                                 boolean imagenIzquierda, float bloqueHeight) {
        // Layout horizontal 50/50: imagen y card alternan lado según el índice.
        // setHeight fija el alto del bloque para que entren PRODUCTOS_POR_PAGINA
        // por hoja distribuidos parejo (mismo patrón que CellBuilder del catalog).
        Table layout = new Table(UnitValue.createPercentArray(new float[]{1f, 1f}))
                .useAllAvailableWidth()
                .setHeight(bloqueHeight)
                .setBorder(Border.NO_BORDER);

        // Imagen escalada a un tamaño que entre en el bloque dejando espacio a los lados.
        float imgSize = Math.min(140f, bloqueHeight - 20f);

        // ----- Celda de imagen -----
        Cell celdaImagen = new Cell()
                .setBorder(Border.NO_BORDER)
                .setVerticalAlignment(VerticalAlignment.MIDDLE)
                .setHorizontalAlignment(HorizontalAlignment.CENTER)
                .setPadding(4);
        Image img = cargarImagenProducto(it.sku(), sinImagenData, imgSize);
        if (img != null) {
            img.setHorizontalAlignment(HorizontalAlignment.CENTER).setAutoScale(false);
            img.scaleToFit(imgSize, imgSize);
            celdaImagen.add(img);
        }

        // ----- Card gris con info del producto -----
        Div card = new Div()
                .setBackgroundColor(GRIS_CLARO)
                .setBorderRadius(new BorderRadius(8f))
                .setPadding(12)
                .setMargin(0);

        // SKU como pill naranja, ancho completo, centrado.
        Paragraph sku = new Paragraph(safe(it.sku(), "—"))
                .simulateBold()
                .setFontSize(11)
                .setFontColor(KT_AZUL_CODIGO_TEXTO)
                .setBackgroundColor(KT_NARANJA_CODIGO)
                .setBorderRadius(new BorderRadius(10f))
                .setTextAlignment(TextAlignment.CENTER)
                .setPaddings(3, 8, 3, 8)
                .setMargin(0)
                .setMarginBottom(4);
        card.add(sku);
        card.add(buildLineaSeparadora());

        // Nombre del producto centrado, bold, en marrón KT (paleta del tema).
        Paragraph nombre = new Paragraph(safe(it.descripcion(), "—"))
                .simulateBold()
                .setFontSize(11)
                .setFontColor(KT_MARRON)
                .setTextAlignment(TextAlignment.CENTER)
                .setMultipliedLeading(1.15f)
                .setMargin(0)
                .setPadding(2);
        card.add(nombre);
        card.add(buildLineaSeparadora());

        // Precio con la forma de pago predefinida (destacada) del perfil del
        // rubro — el mismo que ve el cliente al escanear (menaje al precio
        // efectivo, maquinaria s/IVA), sin descuentos de escala. Etiqueta sutil
        // en gris para que no compita con el valor; valor en verde KT.
        BigDecimal precioFinal = it.precioMostrado();
        Paragraph precioEtiqueta = new Paragraph("PRECIO")
                .setFontSize(8)
                .setFontColor(GRIS_OSCURO)
                .setCharacterSpacing(1.5f)
                .setTextAlignment(TextAlignment.CENTER)
                .setMargin(0)
                .setMarginTop(6);
        Paragraph precioValor = new Paragraph(formatPesos(precioFinal))
                .simulateBold()
                .setFontSize(16)
                .setFontColor(VERDE_PRECIO)
                .setTextAlignment(TextAlignment.CENTER)
                .setMargin(0);
        card.add(precioEtiqueta);
        card.add(precioValor);

        Cell celdaCard = new Cell()
                .setBorder(Border.NO_BORDER)
                .setVerticalAlignment(VerticalAlignment.MIDDLE)
                .setPadding(8)
                .add(card);

        if (imagenIzquierda) {
            layout.addCell(celdaImagen);
            layout.addCell(celdaCard);
        } else {
            layout.addCell(celdaCard);
            layout.addCell(celdaImagen);
        }
        return layout;
    }

    /** Línea separadora delgada entre los componentes de la card (SKU / nombre / precio).
     *  Mismo patrón que el LineComponent del catalog generator. */
    private static Paragraph buildLineaSeparadora() {
        return new Paragraph()
                .setBorder(new SolidBorder(GRIS_LINEA, 0.5f))
                .setMargin(0)
                .setPadding(0);
    }

    // =====================================================
    // Helpers
    // =====================================================

    /** Carga la imagen del producto preprocesada (recorte + resize + JPEG)
     *  vía {@link PdfImagenUtils}. Si no hay imagen local cae al fallback. */
    private Image cargarImagenProducto(String sku, PdfImagenReutilizable fallback, float displaySizePt) {
        File archivo = imagenLocalService.buscar(sku).orElse(null);
        return PdfImagenUtils.cargarImagenProducto(archivo, fallback, displaySizePt);
    }

    private ImageData cargarRecurso(String resourcePath) {
        return PdfImagenUtils.cargarImagenClasspath(resourcePath);
    }

    private static String formatPesos(BigDecimal v) {
        if (v == null || v.signum() == 0) return "-";
        return PdfFormatoUtils.formatPesos(v);
    }

    private static String safe(String s, String fallback) {
        return PdfFormatoUtils.safe(s, fallback);
    }

    /**
     * Pinta el footer: logo KT a la izquierda + "Página X" centrado. Layout
     * portado del java-pdf-catalog-generator (FooterHandler.java) — el icono
     * va levemente a la izquierda del centro y el texto comienza en el centro.
     * Se omite la portada (página 1) y la numeración arranca en 1 después.
     */
    private static class FooterHandler extends AbstractPdfDocumentEventHandler {
        private final PdfDocument pdfDoc;
        private final PdfImagenReutilizable logo;

        FooterHandler(PdfDocument pdfDoc, PdfImagenReutilizable logo) {
            this.pdfDoc = pdfDoc;
            this.logo = logo;
        }

        @Override
        protected void onAcceptedEvent(AbstractPdfDocumentEvent event) {
            try {
                PdfDocumentEvent docEvent = (PdfDocumentEvent) event;
                PdfPage page = docEvent.getPage();
                int pageNum = pdfDoc.getPageNumber(page);
                if (pageNum == 1) return;
                int displayPageNum = pageNum - 1;

                float pageWidth = page.getPageSize().getWidth();
                float y = 20f;
                float textX = pageWidth / 2f;
                float logoX = pageWidth / 2f - 40f;
                float logoW = 30f;
                float logoH = 25f;

                PdfCanvas pdfCanvas = new PdfCanvas(
                        page.newContentStreamAfter(), page.getResources(), pdfDoc);

                // Logo a la izquierda del texto, centrado verticalmente con éste.
                if (logo != null) {
                    Rectangle logoRect = new Rectangle(logoX, y - logoH / 2f, logoW, logoH);
                    pdfCanvas.addXObjectFittedIntoRectangle(logo.xObject(), logoRect);
                }

                // Texto comienza en textX (centro de la página) y se extiende a la derecha.
                Rectangle textArea = new Rectangle(textX, y - 4f, pageWidth / 2f - 20f, 14f);
                try (Canvas canvas = new Canvas(pdfCanvas, textArea)) {
                    Paragraph p = new Paragraph("Página " + displayPageNum)
                            .setFontSize(10)
                            .setFontColor(KT_MARRON)
                            .setMargin(0);
                    canvas.add(p);
                }
            } catch (Exception ignored) {
                // El footer es decorativo — si falla, el PDF sigue siendo válido.
            }
        }
    }

    private static class BackgroundHandler extends AbstractPdfDocumentEventHandler {
        private final PdfDocument pdfDoc;
        private final PdfImagenReutilizable portada;
        private final PdfImagenReutilizable interior;

        BackgroundHandler(PdfDocument pdfDoc, PdfImagenReutilizable portada, PdfImagenReutilizable interior) {
            this.pdfDoc = pdfDoc;
            this.portada = portada;
            this.interior = interior;
        }

        @Override
        protected void onAcceptedEvent(AbstractPdfDocumentEvent event) {
            try {
                PdfDocumentEvent docEvent = (PdfDocumentEvent) event;
                PdfPage page = docEvent.getPage();
                int pageNum = pdfDoc.getPageNumber(page);
                PdfImagenReutilizable bg = pageNum == 1 ? portada : interior;
                if (bg == null) return;
                Rectangle area = page.getPageSize();
                PdfCanvas canvas = new PdfCanvas(page.newContentStreamBefore(), page.getResources(), pdfDoc);
                canvas.addXObjectFittedIntoRectangle(bg.xObject(), area);
            } catch (Exception ignored) {
                // El background es decorativo — si falla, el PDF sigue siendo válido.
            }
        }
    }
}
