package ar.com.leo.showroom.picking;

import ar.com.leo.showroom.catalogo.service.ImagenLocalService;
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

import javax.imageio.IIOImage;
import javax.imageio.ImageIO;
import javax.imageio.ImageWriteParam;
import javax.imageio.ImageWriter;
import javax.imageio.plugins.jpeg.JPEGImageWriteParam;
import javax.imageio.stream.ImageOutputStream;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.math.BigDecimal;
import java.text.NumberFormat;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.Locale;
import java.util.Optional;

/**
 * Genera un PDF de presupuesto con tema KT GASTRO para mandarle al cliente.
 * Estilo portado del java-pdf-catalog-generator existente: mismos colores,
 * backgrounds y footer (logo KT + "Página X" al pie de cada página, omitiendo
 * la portada). Layout: carátula con razón social + fecha + CUIT, y páginas de
 * 4 productos cada una con CÓDIGO | NOMBRE | PRECIO s/IVA | FOTO (sin
 * valorización total — pedido del cliente).
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class PresupuestoPdfGenerator {

    private static final int PRODUCTOS_POR_PAGINA = 4;

    /** DPI objetivo para las imágenes de productos embebidas. 200 DPI alcanza
     *  para visualización en pantalla/mobile sin pixelado al hacer zoom medio
     *  (a 140pt de celda → 389×389 px, vs ~186 px que se ven realmente).
     *  El catalog generator usa 400 DPI pero ese PDF es para impresión; este
     *  va por SMTP a Gmail, que en uploads de 18+ MB cierra el socket antes
     *  del ACK 250 y termina en SocketTimeoutException. */
    private static final float TARGET_DPI = 200f;

    /** Calidad JPEG de las imágenes de productos. 0.78 es imperceptible para
     *  fotos de producto típicas (fondo blanco, pocos detalles finos) y reduce
     *  ~25% extra de bytes vs 0.85. El catalog generator usa 0.95 pero ese
     *  PDF es para impresión; este es para email/pantalla. */
    private static final float JPEG_QUALITY = 0.78f;

    // Tema KT (colores extraídos de KitchenToolsTheme del catalog generator).
    private static final Color KT_NARANJA = new DeviceRgb(255, 134, 28);
    private static final Color KT_MARRON = new DeviceRgb(59, 30, 9);
    private static final Color KT_NARANJA_CODIGO = new DeviceRgb(255, 135, 12);
    private static final Color KT_AZUL_CODIGO_TEXTO = new DeviceRgb(72, 65, 151);
    private static final Color GRIS_OSCURO = new DeviceRgb(45, 45, 45);
    private static final Color GRIS_CLARO = new DeviceRgb(235, 235, 235);
    /** Gris medio para las líneas separadoras dentro de la card gris (la card
     *  es 235,235,235 — una línea del mismo gris no se vería). */
    private static final Color GRIS_LINEA = new DeviceRgb(200, 200, 200);
    /** Verde profundo para el precio — combina con el verde del logo KT (la
     *  olla alrededor de la K) y contrasta con el naranja del pill SKU. */
    private static final Color VERDE_PRECIO = new DeviceRgb(16, 122, 87);

    private static final DateTimeFormatter FECHA_FORMATTER = DateTimeFormatter.ofPattern("dd/MM/yyyy");
    /** TZ del showroom: la fecha del pedido se computa según AR aunque la JVM
     *  corra en UTC (caso típico en cloud). */
    private static final ZoneId TZ_AR = ZoneId.of("America/Argentina/Buenos_Aires");
    private static final NumberFormat PESO_FMT = NumberFormat.getCurrencyInstance(Locale.of("es", "AR"));
    static {
        PESO_FMT.setMaximumFractionDigits(0);
        PESO_FMT.setMinimumFractionDigits(0);
    }

    private final ImagenLocalService imagenLocalService;

    public byte[] generar(PedidoShowroom pedido) {
        // PDF de los items COMPRADOS (a partir del pedido). Usado por el endpoint
        // GET /pedidos/{id}/pdf. El PDF muestra el precio base del producto (el
        // mismo del scan, s/IVA), sin recargo financiero — para eso "deshacemos"
        // el recargo y el flag aplicaIva del precio guardado.
        boolean precioConIva = !Boolean.FALSE.equals(pedido.getFormaPagoAplicaIva());
        BigDecimal recargoPorc = pedido.getRecargoPorcentaje();
        List<ItemView> views = pedido.getItems().stream()
                .map(it -> fromPedidoItem(it, precioConIva, recargoPorc))
                .toList();
        return generarConItems(pedido, views);
    }

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
        List<ItemView> views = sesion.getItems().stream()
                .filter(it -> !skusComprados.contains(it.getSku()))
                .map(PresupuestoPdfGenerator::fromSesionItem)
                .toList();
        if (views.isEmpty()) {
            return null;
        }
        return generarConItems(pedido, views);
    }

    /**
     * PDF de TODOS los items escaneados durante una sesión, sin filtrar por
     * compra — para sesiones ABANDONADAS donde el cliente miró productos pero
     * no derivó en pedido. La portada usa el nombre y fecha de la sesión.
     *
     * @return null si la sesión no tiene items (no hay nada que mandar).
     */
    public byte[] generarHistorialSesion(SesionShowroom sesion) {
        List<ItemView> views = sesion.getItems().stream()
                .map(PresupuestoPdfGenerator::fromSesionItem)
                .toList();
        if (views.isEmpty()) {
            return null;
        }
        // Stub de PedidoShowroom para reusar la portada — solo necesitamos
        // nombre y fecha. CUIT queda null (sin pedido no hay cliente registrado).
        PedidoShowroom stub = PedidoShowroom.builder()
                .nombre(sesion.getNombre())
                .creadoAt(sesion.getIniciadaAt())
                .build();
        return generarConItems(stub, views);
    }

    /** Filename para sesión sin pedido — usa el id de la sesión en vez del id de pedido. */
    public String nombreArchivoSesion(SesionShowroom sesion) {
        LocalDate fecha = sesion.getIniciadaAt() != null
                ? sesion.getIniciadaAt().atZone(TZ_AR).toLocalDate()
                : LocalDate.now(TZ_AR);
        String cliente = NombreArchivoUtils.sanitizar(sesion.getNombre());
        return "presupuesto-" + cliente + "-sesion-" + sesion.getId() + "-"
                + fecha.format(DateTimeFormatter.ofPattern("ddMMyyyy")) + ".pdf";
    }

    /** Pipeline común: portada con datos del pedido + N páginas con los items. */
    private byte[] generarConItems(PedidoShowroom pedido, List<ItemView> items) {
        try (ByteArrayOutputStream out = new ByteArrayOutputStream();
             PdfWriter writer = new PdfWriter(out);
             PdfDocument pdfDoc = new PdfDocument(writer);
             Document doc = new Document(pdfDoc, PageSize.A4)) {

            doc.setMargins(40, 40, 40, 40);

            // Background images: carátula primera página + interior en el resto.
            ImageData bgPortada = cargarRecurso("/images/backgroundKT.png");
            ImageData bgInterior = cargarRecurso("/images/backgroundwhiteKT.png");
            ImageData logoKT = cargarRecurso("/images/logoKT.png");
            pdfDoc.addEventHandler(PdfDocumentEvent.START_PAGE, new BackgroundHandler(pdfDoc, bgPortada, bgInterior));
            pdfDoc.addEventHandler(PdfDocumentEvent.END_PAGE, new FooterHandler(pdfDoc, logoKT));

            ImageData sinImagen = cargarRecurso("/images/SINIMAGEN.jpg");

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

    /** Vista de un item para renderizar — solo los campos que necesita el block.
     *  Permite reusar el mismo template para PedidoShowroomItem y SesionScanItem. */
    private record ItemView(String sku, String descripcion, java.math.BigDecimal precioConIva, java.math.BigDecimal porcIva) {}

    /**
     * Reconstruye el precio base del producto (el del scan, c/IVA, sin recargo
     * financiero) a partir del precio guardado en el pedido. Pasos:
     *  <ul>
     *    <li>Si {@code precioYaConIva=false} (forma "no aplica IVA"), suma IVA
     *        para llevarlo a c/IVA.</li>
     *    <li>Si hubo {@code recargoPorc>0}, multiplica por {@code (1 - recargo/100)}
     *        para deshacer el recargo (el {@code precioUnitario} se calculó
     *        dividiendo por ese mismo factor).</li>
     *  </ul>
     * El render del PDF aplica luego {@code sinIva()}, igual que para los items
     * de sesión — así el cliente ve el mismo precio que vio al escanear el
     * producto, sin descuentos de escala ni recargos.
     */
    private static ItemView fromPedidoItem(PedidoShowroomItem it, boolean precioYaConIva, BigDecimal recargoPorc) {
        BigDecimal precio = it.getPrecioUnitario();
        BigDecimal porcIva = it.getPorcIva();
        if (precio != null && !precioYaConIva && porcIva != null && porcIva.signum() > 0) {
            BigDecimal ivaFactor = BigDecimal.ONE.add(porcIva.movePointLeft(2));
            precio = precio.multiply(ivaFactor);
        }
        if (precio != null && recargoPorc != null && recargoPorc.signum() > 0) {
            BigDecimal factorSinRecargo = BigDecimal.ONE.subtract(recargoPorc.movePointLeft(2));
            precio = precio.multiply(factorSinRecargo);
        }
        return new ItemView(it.getSku(), it.getDescripcion(), precio, porcIva);
    }

    private static ItemView fromSesionItem(SesionScanItem it) {
        return new ItemView(it.getSku(), it.getDescripcion(), it.getPrecioConIva(), it.getPorcIva());
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

    private void agregarPortada(Document doc, PedidoShowroom pedido, ImageData logo) {
        // Logo grande KT (con olla + "KITCHENTOOLS"), igual al catalog generator.
        Image logoImg = null;
        if (logo != null) {
            logoImg = new Image(logo);
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

    private void agregarPaginasProductos(Document doc, List<ItemView> items, ImageData sinImagen) {
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

    private Table buildItemBlock(ItemView it, ImageData sinImagenData,
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

        // Precio sin IVA del producto — el mismo que se muestra al escanear,
        // sin afectaciones por descuentos de escala ni recargos financieros.
        // Etiqueta sutil en gris para que no compita con el valor; valor en
        // naranja KT para que destaque y combine con el resto del tema.
        BigDecimal precioSinIvaFinal = sinIva(it.precioConIva(), it.porcIva());
        Paragraph precioEtiqueta = new Paragraph("PRECIO")
                .setFontSize(8)
                .setFontColor(GRIS_OSCURO)
                .setCharacterSpacing(1.5f)
                .setTextAlignment(TextAlignment.CENTER)
                .setMargin(0)
                .setMarginTop(6);
        Paragraph precioValor = new Paragraph(formatPesos(precioSinIvaFinal))
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

    /**
     * Carga la imagen del producto y la prepara para embeber en el PDF:
     * <ol>
     *   <li>Recorta los bordes blancos (R/G/B &gt;= 240) con 50px de margen
     *       vertical extra — aprovecha mejor la celda cuando la foto tiene
     *       mucho fondo blanco.</li>
     *   <li>Redimensiona con interpolación bicúbica a {@code displaySizePt × TARGET_DPI / 72}
     *       — embebir 3000×3000 px para mostrar a 140 pt es 16× más bytes de
     *       lo que el PDF puede mostrar. Esto es donde más se gana en tamaño.</li>
     *   <li>Encodea como JPEG con Huffman tables optimizadas — ~10–15% extra
     *       de compresión a misma calidad visual.</li>
     * </ol>
     * Receta portada del {@code java-pdf-catalog-generator} (proyecto hermano).
     *
     * <p>Si {@code ImageIO} no puede leer el formato (ej. webp animado),
     * carga el archivo tal cual sin recortar — iText soporta más formatos
     * que ImageIO. Si la imagen es completamente blanca o falla el procesado,
     * cae al fallback (SINIMAGEN).
     *
     * @param displaySizePt tamaño máximo de la imagen en puntos PDF — define el
     *                      target en píxeles vía {@link #TARGET_DPI}.
     */
    private Image cargarImagenProducto(String sku, ImageData fallback, float displaySizePt) {
        Optional<File> fileOpt = imagenLocalService.buscar(sku);
        if (fileOpt.isEmpty()) {
            return fallback != null ? new Image(fallback) : null;
        }
        File file = fileOpt.get();
        try {
            BufferedImage original = ImageIO.read(file);
            if (original == null) {
                // ImageIO no soporta el formato — lo cargamos tal cual via iText.
                return new Image(ImageDataFactory.create(file.toString()));
            }
            BufferedImage recortada = recortarBordesBlancos(original);
            if (recortada == null) {
                log.warn("Imagen sin contenido visible (toda blanca): {}", file.getName());
                return fallback != null ? new Image(fallback) : null;
            }
            int targetPx = Math.max(1, Math.round(displaySizePt * TARGET_DPI / 72f));
            BufferedImage preparada = redimensionarParaJpeg(recortada, targetPx);
            byte[] jpeg = encodeJpeg(preparada, JPEG_QUALITY);
            return new Image(ImageDataFactory.create(jpeg));
        } catch (Exception e) {
            log.warn("Error procesando imagen {}: {}", file.getName(), e.getMessage());
            return fallback != null ? new Image(fallback) : null;
        }
    }

    /**
     * Reduce la imagen a {@code maxDim} píxeles en su dimensión más larga
     * (manteniendo aspect ratio) y la aplana contra fondo blanco para que
     * sea válida como JPEG. Usa interpolación bicúbica + antialiasing para
     * mantener nitidez en el downscale.
     *
     * <p>Si la imagen ya es ≤ maxDim en ambos lados, igual se copia a un
     * {@code TYPE_INT_RGB} (necesario para JPEG; aplana el alpha).
     */
    private static BufferedImage redimensionarParaJpeg(BufferedImage src, int maxDim) {
        int w = src.getWidth();
        int h = src.getHeight();
        int largest = Math.max(w, h);
        int targetW, targetH;
        if (largest > maxDim) {
            double scale = (double) maxDim / largest;
            targetW = Math.max(1, (int) Math.round(w * scale));
            targetH = Math.max(1, (int) Math.round(h * scale));
        } else {
            targetW = w;
            targetH = h;
        }
        BufferedImage out = new BufferedImage(targetW, targetH, BufferedImage.TYPE_INT_RGB);
        Graphics2D g = out.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BICUBIC);
        g.setRenderingHint(RenderingHints.KEY_RENDERING, RenderingHints.VALUE_RENDER_QUALITY);
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        g.setColor(java.awt.Color.WHITE);
        g.fillRect(0, 0, targetW, targetH);
        g.drawImage(src, 0, 0, targetW, targetH, null);
        g.dispose();
        return out;
    }

    /**
     * Encodea un {@link BufferedImage} a JPEG con la calidad indicada y Huffman
     * tables optimizadas. El input debe ser {@code TYPE_INT_RGB} (sin alpha) —
     * {@link #redimensionarParaJpeg} se encarga de la conversión.
     */
    private static byte[] encodeJpeg(BufferedImage img, float quality) throws java.io.IOException {
        ImageWriter writer = ImageIO.getImageWritersByFormatName("jpg").next();
        try (ByteArrayOutputStream baos = new ByteArrayOutputStream();
             ImageOutputStream ios = ImageIO.createImageOutputStream(baos)) {
            writer.setOutput(ios);
            ImageWriteParam param = writer.getDefaultWriteParam();
            param.setCompressionMode(ImageWriteParam.MODE_EXPLICIT);
            param.setCompressionQuality(quality);
            if (param instanceof JPEGImageWriteParam) {
                ((JPEGImageWriteParam) param).setOptimizeHuffmanTables(true);
            }
            writer.write(null, new IIOImage(img, null, null), param);
            return baos.toByteArray();
        } finally {
            writer.dispose();
        }
    }

    /**
     * Detecta el bounding box de píxeles "no blancos" (R, G o B &lt; 240) y
     * devuelve la subimagen recortada con 50px de margen vertical extra arriba
     * y abajo (para que el producto no quede pegado al borde de la celda).
     * Devuelve {@code null} si la imagen es completamente blanca.
     */
    private static BufferedImage recortarBordesBlancos(BufferedImage original) {
        final int width = original.getWidth();
        final int height = original.getHeight();
        final int threshold = 240;
        // Lectura masiva de píxeles — mucho más rápido que getRGB(x,y) por píxel.
        int[] pixels = original.getRGB(0, 0, width, height, null, 0, width);
        int left = width, right = -1, top = height, bottom = -1;
        for (int y = 0, idx = 0; y < height; y++) {
            for (int x = 0; x < width; x++, idx++) {
                int rgb = pixels[idx];
                int r = (rgb >> 16) & 0xff;
                int g = (rgb >> 8) & 0xff;
                int b = rgb & 0xff;
                if (r < threshold || g < threshold || b < threshold) {
                    if (x < left) left = x;
                    if (x > right) right = x;
                    if (y < top) top = y;
                    if (y > bottom) bottom = y;
                }
            }
        }
        if (right < left || bottom < top) {
            return null;
        }
        final int marginVertical = 50;
        top = Math.max(0, top - marginVertical);
        bottom = Math.min(height - 1, bottom + marginVertical);
        return original.getSubimage(left, top, right - left + 1, bottom - top + 1);
    }

    private ImageData cargarRecurso(String resourcePath) {
        try {
            return ImageDataFactory.create(getClass().getResource(resourcePath).toExternalForm());
        } catch (Exception e) {
            log.warn("No se pudo cargar el recurso PDF {}: {}", resourcePath, e.getMessage());
            return null;
        }
    }

    /** Saca el IVA del precio. Si porcIva es null o 0, devuelve el mismo valor. */
    private static BigDecimal sinIva(BigDecimal precioConIva, BigDecimal porcIva) {
        if (precioConIva == null) return null;
        if (porcIva == null || porcIva.signum() == 0) return precioConIva;
        BigDecimal divisor = BigDecimal.ONE.add(porcIva.movePointLeft(2));
        return precioConIva.divide(divisor, 4, java.math.RoundingMode.HALF_UP);
    }

    private static String formatPesos(BigDecimal v) {
        if (v == null || v.signum() == 0) return "-";
        return PESO_FMT.format(v.doubleValue());
    }

    private static String safe(String s, String fallback) {
        return s == null || s.isBlank() ? fallback : s;
    }

    /**
     * Pinta el footer: logo KT a la izquierda + "Página X" centrado. Layout
     * portado del java-pdf-catalog-generator (FooterHandler.java) — el icono
     * va levemente a la izquierda del centro y el texto comienza en el centro.
     * Se omite la portada (página 1) y la numeración arranca en 1 después.
     */
    private static class FooterHandler extends AbstractPdfDocumentEventHandler {
        private final PdfDocument pdfDoc;
        private final ImageData logo;

        FooterHandler(PdfDocument pdfDoc, ImageData logo) {
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
                    pdfCanvas.addImageFittedIntoRectangle(logo, logoRect, false);
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
        private final ImageData portada;
        private final ImageData interior;

        BackgroundHandler(PdfDocument pdfDoc, ImageData portada, ImageData interior) {
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
                ImageData bg = pageNum == 1 ? portada : interior;
                if (bg == null) return;
                Rectangle area = page.getPageSize();
                PdfCanvas canvas = new PdfCanvas(page.newContentStreamBefore(), page.getResources(), pdfDoc);
                canvas.addImageFittedIntoRectangle(bg, area, false);
            } catch (Exception ignored) {
                // El background es decorativo — si falla, el PDF sigue siendo válido.
            }
        }
    }
}
