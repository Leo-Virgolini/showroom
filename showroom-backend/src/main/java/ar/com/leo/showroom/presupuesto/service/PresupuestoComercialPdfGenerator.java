package ar.com.leo.showroom.presupuesto.service;

import ar.com.leo.showroom.catalogo.service.ImagenLocalService;
import ar.com.leo.showroom.common.pdf.PdfImagenUtils;
import ar.com.leo.showroom.presupuesto.dto.GenerarPresupuestoRequestDTO;
import ar.com.leo.showroom.presupuesto.entity.PresupuestoComercial;
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
import com.itextpdf.layout.element.IBlockElement;
import com.itextpdf.layout.element.Image;
import com.itextpdf.layout.element.Paragraph;
import com.itextpdf.layout.element.Table;
import com.itextpdf.layout.element.Text;
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
import java.math.RoundingMode;
import java.text.NumberFormat;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Optional;

/**
 * Genera el PDF de presupuesto comercial — el que el operador arma en la
 * pantalla /presupuestos eligiendo items con descuento individual y formas
 * de pago. Layout inspirado en el sample "llamadorinalambrico" del cliente
 * pero con la paleta KT GASTRO (naranja + marrón + logo + backgrounds que
 * ya viven en /resources/images).
 *
 * <p>Estructura por página (A4):
 * <ol>
 *   <li>Header marrón con "PRESUPUESTO #N" alineado a la derecha.</li>
 *   <li>Card con logo KT, datos del cliente (nombre + teléfono) y fecha.</li>
 *   <li>Tabla "Detalle de productos": foto, código (pill), descripción, cant,
 *       precio, descuento, total.</li>
 *   <li>Subtotales: IVA + Total en pesos.</li>
 *   <li>Cards de "Formas de pago disponibles" — cada una con su precio final.</li>
 *   <li>Observaciones (opcional) y footer con "Página X" + logo chico.</li>
 * </ol>
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class PresupuestoComercialPdfGenerator {

    // Tema KT (mismos colores que PresupuestoPdfGenerator de pedidos).
    private static final Color KT_NARANJA = new DeviceRgb(255, 134, 28);
    private static final Color KT_MARRON = new DeviceRgb(59, 30, 9);
    private static final Color KT_AZUL_CODIGO_TEXTO = new DeviceRgb(72, 65, 151);
    private static final Color VERDE_PRECIO = new DeviceRgb(16, 122, 87);
    private static final Color GRIS_OSCURO = new DeviceRgb(45, 45, 45);
    private static final Color GRIS_MEDIO = new DeviceRgb(110, 110, 110);
    private static final Color GRIS_CLARO = new DeviceRgb(243, 244, 246);
    private static final Color GRIS_LINEA = new DeviceRgb(225, 225, 230);

    /** Fondos suaves para los chips de cantidad/descuento/unitario que
     *  aparecen en el header de cada hoja en modo cotización individual.
     *  Tono pastel para que el texto bold (marrón / verde / azul fuerte)
     *  tenga contraste sin competir con los precios destacados de las
     *  cards de formas de pago. */
    private static final Color CHIP_BG_NARANJA = new DeviceRgb(255, 234, 209);
    private static final Color CHIP_BG_VERDE = new DeviceRgb(216, 244, 230);
    private static final Color CHIP_BG_AZUL = new DeviceRgb(219, 234, 254);
    private static final Color CHIP_FG_AZUL = new DeviceRgb(29, 78, 216);
    /** Color para el precio tachado dentro del chip azul — gris medio neutro
     *  que comunica "precio anterior" sin competir con el azul fuerte del
     *  texto principal. */
    private static final Color CHIP_TACHADO = new DeviceRgb(90, 90, 90);

    /** Colores únicos para los borde-top de las cards de formas de pago.
     *  10 colores bien diferenciados — si hay más formas que esto, ciclan.
     *  Sincronizado con .color-1..10 en presupuestos-page.scss. */
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

    private final ImagenLocalService imagenLocalService;

    public byte[] generar(PresupuestoComercial presupuesto,
                          GenerarPresupuestoRequestDTO datos) {
        try (ByteArrayOutputStream out = new ByteArrayOutputStream();
             PdfWriter writer = new PdfWriter(out);
             PdfDocument pdfDoc = new PdfDocument(writer);
             Document doc = new Document(pdfDoc, PageSize.A4)) {

            doc.setMargins(30, 30, 40, 30);

            ImageData bgInterior = cargarRecurso("/images/backgroundwhiteKT.png");
            // Header: logo completo "KITCHENTOOLS GASTRO" (3.42:1, 640×187),
            // el mismo .webp del frontend convertido a PNG porque iText no lee
            // WebP. Footer: ícono compacto (solo la K en círculo), que se ve
            // bien en 30×25pt.
            ImageData logoHeader = cargarRecurso("/images/kt-gastro-logo.png");
            ImageData logoFooter = cargarRecurso("/images/logoKT.png");
            // Fallback que se usa cuando un producto no tiene foto en la
            // carpeta local — evita celdas vacías en la tabla.
            ImageData sinImagen = cargarRecurso("/images/SINIMAGEN.jpg");
            pdfDoc.addEventHandler(PdfDocumentEvent.START_PAGE,
                    new BackgroundHandler(bgInterior));
            pdfDoc.addEventHandler(PdfDocumentEvent.END_PAGE,
                    new FooterHandler(pdfDoc, logoFooter));

            boolean individual = Boolean.TRUE.equals(datos.cotizacionIndividual());
            if (individual) {
                // Modo "cotización individual": una hoja por cada ítem con su
                // foto + sus propias formas de pago calculadas sobre el precio
                // de ese ítem específico. NO hay hoja agregada con total ni
                // formas globales — cada producto se evalúa por separado.
                //
                // Header + card del cliente se agregan UNA SOLA VEZ al
                // principio. Antes se repetían en cada producto y eso forzaba
                // un AreaBreak después de la "portada", dejando la primera
                // página casi vacía y empujando el primer producto a una
                // segunda hoja. Ahora el primer producto comparte página con
                // los datos del cliente, y el resto va detrás (un producto
                // por hoja vía AreaBreak entre items).
                agregarHeader(doc, presupuesto, logoHeader);
                agregarCardCliente(doc, presupuesto);
                List<GenerarPresupuestoRequestDTO.Item> items = datos.items();
                for (int i = 0; i < items.size(); i++) {
                    if (i > 0) doc.add(new AreaBreak());
                    GenerarPresupuestoRequestDTO.Item it = items.get(i);
                    agregarHojaItem(doc, it, i + 1, items.size(), datos.formasPago(), sinImagen);
                }
                // Observaciones al CIERRE del PDF (después del último producto).
                // Si entran al final de la última hoja, perfecto; si no, iText
                // las pasa a una hoja extra de cierre — siempre AL FINAL, así
                // no quedan huérfanas entre dos productos.
                if (esTextoValido(datos.observaciones())) {
                    agregarObservaciones(doc, datos);
                }
            } else {
                // Modo agregado: tabla detalle + total + formas de pago globales,
                // todo en una sola hoja (la layout histórico).
                agregarHeader(doc, presupuesto, logoHeader);
                agregarCardCliente(doc, presupuesto);
                agregarTablaDetalle(doc, datos.items(), sinImagen);
                agregarTotalesAgregado(doc, datos);
                agregarFormasPago(doc, datos.formasPago());
                agregarObservaciones(doc, datos);
            }

            doc.close();
            return out.toByteArray();
        } catch (Exception e) {
            log.error("Error generando PDF de presupuesto comercial {}: {}",
                    presupuesto.getId(), e.getMessage(), e);
            throw new RuntimeException("Error generando PDF de presupuesto", e);
        }
    }

    /** Filename: presupuesto-{cliente}-N{id}-ddMMyyyy.pdf. Cuando no hay id
     *  (preview) usa "borrador" como sufijo. */
    public String nombreArchivo(PresupuestoComercial presupuesto) {
        String cliente = sanitizar(Optional.ofNullable(presupuesto.getClienteNombre()).orElse(""));
        String fecha = presupuesto.getCreadoAt() != null
                ? presupuesto.getCreadoAt().atZone(TZ_AR).toLocalDate()
                        .format(DateTimeFormatter.ofPattern("ddMMyyyy"))
                : "";
        String numero = presupuesto.getId() != null
                ? "N" + presupuesto.getId()
                : "borrador";
        return "presupuesto-" + cliente + "-" + numero
                + (fecha.isEmpty() ? "" : "-" + fecha) + ".pdf";
    }

    // =====================================================
    // Hoja por ítem (modo cotización individual)
    //
    // Cuando el operador activa el toggle "Cotización individual" en el
    // frontend, el PDF emite UNA hoja por cada ítem del listado con:
    //   - Sub-título "PRODUCTO N DE M".
    //   - Card con nombre + SKU del producto.
    //   - Layout 2 columnas: foto a la izquierda, lista de formas de pago a
    //     la derecha calculadas sobre el precio de ESE ítem (precioFinal
    //     viene precalculado del frontend, filtrado por `itemSku`).
    // =====================================================
    private void agregarHojaItem(Document doc,
                                 GenerarPresupuestoRequestDTO.Item item,
                                 int idx,
                                 int total,
                                 List<GenerarPresupuestoRequestDTO.FormaPagoSnapshot> todasFormas,
                                 ImageData sinImagen) {
        // Sub-título "Producto N de M". `setKeepWithNext(true)` lo "pega" al
        // card del producto que viene abajo: si el card (que tiene
        // setKeepTogether) no entra en el espacio remaining de la página
        // actual, el subtitulo también se mueve a la siguiente página. Sin
        // esto, el subtitulo quedaba huérfano al final de la primera página
        // (típicamente cuando los datos del cliente empujan el contenido).
        Paragraph subtitulo = new Paragraph("PRODUCTO " + idx + " DE " + total)
                .simulateBold()
                .setFontSize(10)
                .setCharacterSpacing(2f)
                .setFontColor(ColorConstants.WHITE)
                .setBackgroundColor(KT_NARANJA)
                .setBorderRadius(new BorderRadius(8f))
                .setPaddings(4, 12, 4, 12)
                .setTextAlignment(TextAlignment.CENTER)
                .setMarginTop(8)
                .setMarginBottom(4)
                .setHorizontalAlignment(HorizontalAlignment.LEFT)
                .setWidth(UnitValue.createPercentValue(40))
                .setKeepWithNext(true);
        doc.add(subtitulo);

        // Card del producto: nombre + código arriba, foto | formas de pago abajo.
        // SIN keepTogether: el card es alto (foto grande + N formas de pago)
        // y con keepTogether iText lo movía completo a una nueva página
        // cuando no entraba en el espacio remaining después del header +
        // datos del cliente, dejando la primera hoja casi vacía. Permitir
        // que se parta entre páginas hace que el primer producto comparta
        // página con la portada y el contenido fluya naturalmente.
        Div card = new Div()
                .setMarginTop(0)
                .setBackgroundColor(ColorConstants.WHITE)
                .setBorder(new SolidBorder(GRIS_LINEA, 1f))
                .setBorderRadius(new BorderRadius(12f))
                .setPadding(10);

        // Encabezado del producto: nombre + sku + chips visuales para
        // (cantidad / descuento) cuando aplican.
        card.add(new Paragraph(safe(item.descripcion(), "—"))
                .simulateBold()
                .setFontSize(15)
                .setFontColor(KT_MARRON)
                .setTextAlignment(TextAlignment.CENTER)
                .setMargin(0));

        // Sub-línea solo con el código del producto — chico y discreto.
        card.add(new Paragraph("Código: " + safe(item.sku(), "—"))
                .setFontSize(10)
                .setFontColor(GRIS_MEDIO)
                .setTextAlignment(TextAlignment.CENTER)
                .setMargin(0)
                .setMarginBottom(8));

        // Chips de cantidad + descuento + precio unitario (cuando corresponda).
        // Van centrados debajo del código en una fila horizontal. El cliente
        // necesita ver cuántas unidades cubre el presupuesto, si hay descuento
        // aplicado, y cuánto sale c/u — los precios en las cards de formas
        // de pago están totalizados por (cantidad × precio × (1 - descuento)),
        // así que sin esta info no podría reconstruir cómo se llegó al número
        // ni saber cuánto le saldría agregar/quitar unidades.
        BigDecimal cant = item.cantidad();
        BigDecimal desc = item.descuentoPorcentaje();
        // Producto sin precio cargado en DUX: no podemos calcular formas de
        // pago (todas darían $0) ni mostrar precio unitario coherente. En
        // ese caso, ocultamos los chips de precio/descuento y reemplazamos
        // la columna de formas por un mensaje "Consultar precio".
        boolean sinPrecio = item.precioConIva() == null || item.precioConIva().signum() <= 0;
        boolean tieneCant = cant != null && cant.signum() > 0;
        // El descuento solo se muestra si efectivamente hay precio sobre el
        // que aplicar — sino sería "descuento sobre nada".
        boolean tieneDescuento = desc != null && desc.signum() > 0 && !sinPrecio;
        // Chip de precio aparece si:
        //  - Hay cantidad > 1 (precio unitario es informativo distinto del total).
        //  - Hay descuento (mostramos el precio actual + el de lista tachado).
        // No tiene sentido cuando el ítem no tiene precio.
        boolean cantMayorAUno = cant != null && cant.compareTo(BigDecimal.ONE) > 0;
        boolean tieneChipPrecio = (cantMayorAUno || tieneDescuento) && !sinPrecio;
        // tieneChipPrecio ya cubre `tieneDescuento` (es parte de su definición).
        if (tieneCant || tieneChipPrecio) {
            int n = (tieneCant ? 1 : 0) + (tieneDescuento ? 1 : 0) + (tieneChipPrecio ? 1 : 0);
            // Proporciones de columnas según orden: precio (1.6) → desc (0.6, chico)
            // → cantidad (1). La columna del descuento es la más angosta porque
            // su contenido ("-5%") es corto y queremos diferenciarla visualmente
            // como una "etiqueta secundaria" entre los datos más importantes
            // (precio unitario y cantidad).
            float[] cols = new float[n];
            int colIdx = 0;
            if (tieneChipPrecio) cols[colIdx++] = 1.6f;
            if (tieneDescuento) cols[colIdx++] = 0.6f;
            if (tieneCant) cols[colIdx++] = 1f;
            // Width adaptativo: 1 chip → 40%, 2 chips → 70%, 3 chips → 95%.
            float widthPct = n == 1 ? 40f : (n == 2 ? 70f : 95f);
            Table chips = new Table(UnitValue.createPercentArray(cols))
                    .setWidth(UnitValue.createPercentValue(widthPct))
                    .setHorizontalAlignment(HorizontalAlignment.CENTER)
                    .setBorder(Border.NO_BORDER)
                    .setMarginBottom(10);
            // Orden: precio → descuento → cantidad. Cuenta como una "historia"
            // ascendente: este es el precio, con este descuento, y se llevan
            // estas unidades. Lo más importante primero (lo que paga el cliente).
            if (tieneChipPrecio) {
                // Chip azul con el precio (unitario si cant > 1, sino "Precio").
                // Si hay descuento, agregamos al lado el precio de lista
                // tachado en gris para reforzar el ahorro visualmente.
                BigDecimal precioFinalSinIva = precioUnitarioSinIva(item);
                String label = cantMayorAUno ? "P. unitario: " : "Precio: ";
                Paragraph contenido = new Paragraph()
                        .add(new Text(label + formatPesos(precioFinalSinIva)));
                if (tieneDescuento) {
                    BigDecimal listaSinIva = precioListaSinIva(item);
                    // 4 espacios al tamaño normal (9pt) entre los dos precios
                    // para que la rayita del tachado no se conecte con el
                    // precio principal y haya aire visual.
                    contenido.add(new Text("    ").setFontSize(9));
                    contenido.add(new Text(formatPesos(listaSinIva)
                            + (cantMayorAUno ? " c/u" : ""))
                            .setLineThrough()
                            .setFontSize(7.5f)
                            .setFontColor(CHIP_TACHADO));
                }
                chips.addCell(chip(contenido, CHIP_FG_AZUL, CHIP_BG_AZUL));
            }
            if (tieneDescuento) {
                // Chip compacto: solo "-X%" (sin la palabra "descuento") con
                // font + padding más chicos. Se ve como una etiqueta secundaria
                // al lado del precio principal, no compite visualmente.
                chips.addCell(chip(
                        new Paragraph("-" + formatPorcentaje(desc) + "%"),
                        VERDE_PRECIO, CHIP_BG_VERDE, 8f, 6f));
            }
            if (tieneCant) {
                String unidades = cant.compareTo(BigDecimal.ONE) == 0 ? "unidad" : "unidades";
                chips.addCell(chip(formatCantidad(cant) + " " + unidades,
                        KT_MARRON, CHIP_BG_NARANJA));
            }
            card.add(chips);
        }

        // Separador.
        card.add(new Div().setHeight(1).setBackgroundColor(GRIS_LINEA)
                .setMarginBottom(10));

        // Grid 2 cols: foto | formas de pago.
        Table grid = new Table(UnitValue.createPercentArray(new float[]{1.05f, 1.2f}))
                .useAllAvailableWidth()
                .setBorder(Border.NO_BORDER);

        // Col 1: foto grande del producto.
        Cell celdaFoto = new Cell()
                .setBorder(new SolidBorder(GRIS_LINEA, 1f))
                .setBorderRadius(new BorderRadius(8f))
                .setBackgroundColor(ColorConstants.WHITE)
                .setPadding(10)
                .setVerticalAlignment(VerticalAlignment.MIDDLE)
                .setHorizontalAlignment(HorizontalAlignment.CENTER)
                .setTextAlignment(TextAlignment.CENTER);
        Image img = cargarImagenProducto(item.sku(), 260f);
        if (img == null && sinImagen != null) {
            img = new Image(sinImagen);
        }
        if (img != null) {
            img.setAutoScale(false);
            // 200×260 da bastante espacio para que se vea el producto sin
            // dominar la hoja; iText mantiene el aspect ratio.
            img.scaleToFit(200f, 260f);
            img.setHorizontalAlignment(HorizontalAlignment.CENTER);
            celdaFoto.add(img);
        }
        grid.addCell(celdaFoto);

        // Col 2: lista de formas de pago (precalculadas para este ítem).
        // Si el producto no tiene precio cargado, las formas darían todas $0
        // — en lugar de mostrar eso reemplazamos por un mensaje "Consultar
        // precio" más útil para el cliente.
        Cell celdaFormas = new Cell()
                .setBorder(Border.NO_BORDER)
                .setPaddingLeft(12)
                .setVerticalAlignment(VerticalAlignment.MIDDLE);

        if (sinPrecio) {
            Div aviso = new Div()
                    .setBackgroundColor(CHIP_BG_NARANJA)
                    .setBorderRadius(new BorderRadius(10f))
                    .setPadding(20)
                    .setHorizontalAlignment(HorizontalAlignment.CENTER);
            aviso.add(new Paragraph("Consultar precio")
                    .simulateBold()
                    .setFontSize(16)
                    .setFontColor(KT_MARRON)
                    .setTextAlignment(TextAlignment.CENTER)
                    .setMargin(0)
                    .setMarginBottom(6));
            aviso.add(new Paragraph(
                    "Este producto no tiene precio publicado. "
                    + "Comunicate con nosotros para una cotización actualizada.")
                    .setFontSize(10)
                    .setFontColor(GRIS_OSCURO)
                    .setMultipliedLeading(1.3f)
                    .setTextAlignment(TextAlignment.CENTER)
                    .setMargin(0));
            celdaFormas.add(aviso);
        } else {
            List<GenerarPresupuestoRequestDTO.FormaPagoSnapshot> formasItem =
                    filtrarFormasDelItem(todasFormas, item.sku());
            int indiceMejor = indiceMejorPrecio(formasItem);
            celdaFormas.setVerticalAlignment(VerticalAlignment.TOP);
            for (int i = 0; i < formasItem.size(); i++) {
                celdaFormas.add(buildFilaFormaPagoItem(
                        formasItem.get(i),
                        BORDE_FORMA_PAGO[i % BORDE_FORMA_PAGO.length],
                        i == indiceMejor));
            }
        }
        grid.addCell(celdaFormas);

        card.add(grid);
        doc.add(card);
    }

    /** En modo cotización individual cada forma de pago snapshot trae el
     *  {@code itemSku} al que pertenece. Si {@code itemSku} es null lo
     *  consideramos global (todos los ítems). */
    private static List<GenerarPresupuestoRequestDTO.FormaPagoSnapshot> filtrarFormasDelItem(
            List<GenerarPresupuestoRequestDTO.FormaPagoSnapshot> formas, String sku) {
        if (formas == null) return List.of();
        List<GenerarPresupuestoRequestDTO.FormaPagoSnapshot> out = new ArrayList<>();
        for (GenerarPresupuestoRequestDTO.FormaPagoSnapshot f : formas) {
            if (f.itemSku() == null || f.itemSku().equals(sku)) out.add(f);
        }
        return out;
    }

    /** Card-fila horizontal: nombre + descripción a la izquierda, precio a la
     *  derecha, con barrita lateral del color del índice y badge "Mejor precio"
     *  cuando corresponde. Usada solo en modo cotización individual. */
    private Div buildFilaFormaPagoItem(GenerarPresupuestoRequestDTO.FormaPagoSnapshot f,
                                       Color borde, boolean esMejorPrecio) {
        Color colorBarra = esMejorPrecio ? VERDE_PRECIO : borde;

        Table fila = new Table(UnitValue.createPercentArray(new float[]{0.06f, 1.6f, 1f}))
                .useAllAvailableWidth()
                .setBorder(Border.NO_BORDER)
                .setBackgroundColor(GRIS_CLARO)
                .setBorderRadius(new BorderRadius(8f))
                .setMarginBottom(5);

        // Barrita lateral con el color (esquinas redondeadas a la izquierda).
        fila.addCell(new Cell()
                .setBorder(Border.NO_BORDER)
                .setBackgroundColor(colorBarra)
                .setBorderTopLeftRadius(new BorderRadius(8f))
                .setBorderBottomLeftRadius(new BorderRadius(8f))
                .setPadding(0));

        // Nombre + descripción.
        Cell info = new Cell()
                .setBorder(Border.NO_BORDER)
                .setPaddings(6, 8, 6, 10)
                .setVerticalAlignment(VerticalAlignment.MIDDLE);
        if (esMejorPrecio) {
            info.add(new Paragraph("MEJOR PRECIO")
                    .simulateBold()
                    .setFontSize(6.5f)
                    .setCharacterSpacing(0.8f)
                    .setFontColor(ColorConstants.WHITE)
                    .setBackgroundColor(VERDE_PRECIO)
                    .setBorderRadius(new BorderRadius(8f))
                    .setPaddings(1, 6, 1, 6)
                    .setTextAlignment(TextAlignment.CENTER)
                    .setHorizontalAlignment(HorizontalAlignment.LEFT)
                    .setMargin(0)
                    .setMarginBottom(2)
                    .setWidth(60f));
        }
        info.add(new Paragraph(safe(f.nombre(), "—"))
                .simulateBold()
                .setFontSize(9)
                .setFontColor(GRIS_OSCURO)
                .setMargin(0));
        // Indicación de IVA siempre visible (c/IVA o s/IVA). Igual que en la
        // card grande del modo agregado, así el cliente no tiene que adivinar
        // si el precio mostrado ya tiene IVA o se le suma aparte.
        if (f.aplicaIva() != null) {
            info.add(new Paragraph(f.aplicaIva() ? "c/IVA" : "s/IVA")
                    .setFontSize(7.5f)
                    .setFontColor(GRIS_MEDIO)
                    .setMargin(0)
                    .setMarginTop(1));
        }
        // Limpiamos "s/IVA" si viene dentro de la descripción para no
        // duplicar el bloque de arriba (presupuestos viejos lo persistían).
        String desc = f.descripcion();
        if (desc != null) {
            desc = desc.replaceAll("\\s*·\\s*s/IVA", "")
                    .replaceAll("^s/IVA\\s*·\\s*", "")
                    .replaceAll("^s/IVA$", "")
                    .trim();
        }
        if (esTextoValido(desc)) {
            info.add(new Paragraph(desc)
                    .setFontSize(7.5f)
                    .setFontColor(GRIS_MEDIO)
                    .setMargin(0)
                    .setMarginTop(1));
        }
        fila.addCell(info);

        // Precio.
        Cell precioCelda = new Cell()
                .setBorder(Border.NO_BORDER)
                .setPaddings(6, 10, 6, 4)
                .setVerticalAlignment(VerticalAlignment.MIDDLE)
                .setTextAlignment(TextAlignment.RIGHT);
        String simbolo = esTextoValido(f.monedaSimbolo()) ? f.monedaSimbolo() : null;
        String precioStr = simbolo != null
                ? formatNumero(f.precioFinal()) + " " + simbolo
                : formatPesos(f.precioFinal());
        precioCelda.add(new Paragraph(precioStr)
                .simulateBold()
                .setFontSize(13)
                .setFontColor(KT_MARRON)
                .setMargin(0));
        if (f.cantidadCuotas() != null && f.cantidadCuotas() > 1) {
            BigDecimal cuota = f.precioFinal().divide(
                    BigDecimal.valueOf(f.cantidadCuotas()), 2, RoundingMode.HALF_UP);
            precioCelda.add(new Paragraph(
                    f.cantidadCuotas() + " × " + formatPesos(cuota))
                    .setFontSize(7.5f)
                    .setFontColor(GRIS_MEDIO)
                    .setMargin(0)
                    .setMarginTop(1));
        }
        fila.addCell(precioCelda);

        Div w = new Div();
        w.add(fila);
        return w;
    }

    // =====================================================
    // Modo agregado — calcula subtotal bruto + total a partir de los items y
    // delega en la card de totales reutilizable.
    // =====================================================
    private void agregarTotalesAgregado(Document doc, GenerarPresupuestoRequestDTO datos) {
        BigDecimal subtotalBrutoSinIva = BigDecimal.ZERO;
        BigDecimal subtotalSinIva = BigDecimal.ZERO;
        for (GenerarPresupuestoRequestDTO.Item it : datos.items()) {
            BigDecimal cantidad = it.cantidad() == null ? BigDecimal.ZERO : it.cantidad();
            BigDecimal precio = it.precioConIva() == null ? BigDecimal.ZERO : it.precioConIva();
            BigDecimal porcIva = it.porcIva() == null ? BigDecimal.valueOf(21) : it.porcIva();
            BigDecimal desc = it.descuentoPorcentaje() == null ? BigDecimal.ZERO : it.descuentoPorcentaje();
            BigDecimal divisor = BigDecimal.ONE.add(porcIva.movePointLeft(2));

            BigDecimal totalLineaBrutoSinIva = precio.multiply(cantidad)
                    .divide(divisor, 4, RoundingMode.HALF_UP);
            BigDecimal precioConDesc = precio.multiply(
                    BigDecimal.ONE.subtract(desc.movePointLeft(2)));
            BigDecimal totalLineaSinIva = precioConDesc.multiply(cantidad)
                    .divide(divisor, 4, RoundingMode.HALF_UP);

            subtotalBrutoSinIva = subtotalBrutoSinIva.add(totalLineaBrutoSinIva);
            subtotalSinIva = subtotalSinIva.add(totalLineaSinIva);
        }
        BigDecimal subtotalBruto = subtotalBrutoSinIva.setScale(2, RoundingMode.HALF_UP);
        BigDecimal totalSinIva = subtotalSinIva.setScale(2, RoundingMode.HALF_UP);

        agregarCardTotal(doc, subtotalBruto, totalSinIva);

        if (datos.formasPago() == null || datos.formasPago().isEmpty()) return;
        int maxDesc = porcMaxDescuento(totalSinIva, datos.formasPago());
        if (maxDesc <= 0) return;

        Paragraph badge = new Paragraph(
                "¡Podés ahorrar hasta " + maxDesc + "% — mirá las formas de pago!")
                .simulateBold()
                .setFontSize(10)
                .setFontColor(ColorConstants.WHITE)
                .setBackgroundColor(VERDE_PRECIO)
                .setBorderRadius(new BorderRadius(20f))
                .setPaddings(8, 14, 8, 14)
                .setTextAlignment(TextAlignment.CENTER)
                .setMarginTop(10)
                .setMarginBottom(2)
                .setHorizontalAlignment(HorizontalAlignment.CENTER)
                .setWidth(UnitValue.createPercentValue(60));
        doc.add(badge);
    }

    // =====================================================
    // Header — letterhead KT GASTRO:
    //   - Banda decorativa con gradient naranja → verde (mismo gradient que
    //     la PWA, simulado con 3 celdas de degradado porque iText no
    //     soporta linear-gradient nativo).
    //   - Bloque principal con dos zonas:
    //       · Izquierda blanca: logo KT (logoKT.png) sobre fondo claro para
    //         que conserve sus colores originales (naranja + negro).
    //       · Derecha marrón oscuro: "PRESUPUESTO" + "#N" + fecha.
    // =====================================================
    private void agregarHeader(Document doc, PresupuestoComercial p, ImageData logoHeader) {
        // 1) Banda decorativa superior (gradient naranja → amarillo → verde).
        Table banda = new Table(UnitValue.createPercentArray(new float[]{1f, 1f, 1f}))
                .useAllAvailableWidth()
                .setBorder(Border.NO_BORDER)
                .setMarginBottom(0);
        Color verdeBanda = new DeviceRgb(126, 186, 0);
        Color amarilloBanda = new DeviceRgb(162, 171, 0);
        banda.addCell(new Cell().setHeight(5f).setBackgroundColor(KT_NARANJA).setBorder(Border.NO_BORDER));
        banda.addCell(new Cell().setHeight(5f).setBackgroundColor(amarilloBanda).setBorder(Border.NO_BORDER));
        banda.addCell(new Cell().setHeight(5f).setBackgroundColor(verdeBanda).setBorder(Border.NO_BORDER));
        doc.add(banda);

        // 2) Bloque principal — logo a la izquierda (zona blanca) + meta a
        // la derecha (zona marrón). Las dos celdas comparten la misma Table
        // así quedan alineadas verticalmente y con la misma altura.
        Table header = new Table(UnitValue.createPercentArray(new float[]{1.4f, 1f}))
                .useAllAvailableWidth()
                .setBorder(Border.NO_BORDER)
                .setMarginTop(0);

        // === Izquierda: logo sobre fondo blanco/crema ===
        // Padding reducido para que el logo aproveche al máximo el alto
        // disponible — el logo es lo dominante de la cabecera, no debe
        // verse perdido en el medio de un mar blanco como pasaba antes.
        Cell izq = new Cell()
                .setBorder(Border.NO_BORDER)
                .setVerticalAlignment(VerticalAlignment.MIDDLE)
                .setBackgroundColor(ColorConstants.WHITE)
                .setPaddings(10, 18, 10, 20);
        if (logoHeader != null) {
            Image logo = new Image(logoHeader);
            // Altura fija — el ancho lo ajusta iText con el aspect ratio
            // real del PNG, evitando deformación si en algún futuro se
            // reemplaza la imagen por otra de proporciones distintas.
            // 72pt × ratio 3.42 = ~246pt de ancho, encaja en la celda
            // izquierda (≈266pt útiles después del padding).
            logo.setHeight(72f);
            logo.setHorizontalAlignment(HorizontalAlignment.LEFT);
            izq.add(logo);
        } else {
            // Fallback textual si la imagen no se pudo cargar.
            izq.add(new Paragraph("KITCHENTOOLS")
                    .simulateBold()
                    .setFontColor(KT_MARRON)
                    .setCharacterSpacing(1.5f)
                    .setFontSize(15)
                    .setMargin(0));
            izq.add(new Paragraph("GASTRONOMIA")
                    .simulateBold()
                    .setFontColor(KT_NARANJA)
                    .setCharacterSpacing(2f)
                    .setFontSize(10)
                    .setMargin(0));
        }

        // === Derecha: "PRESUPUESTO" + "#N" + fecha en fondo marrón ===
        String numero = p.getId() != null ? "#" + p.getId() : "—";
        String fechaCorta = p.getCreadoAt() != null
                ? p.getCreadoAt().atZone(TZ_AR).toLocalDate()
                        .format(DateTimeFormatter.ofPattern("dd/MM/yyyy"))
                : "";

        Cell der = new Cell()
                .setBorder(Border.NO_BORDER)
                .setVerticalAlignment(VerticalAlignment.MIDDLE)
                .setBackgroundColor(KT_MARRON)
                .setPaddings(18, 22, 18, 22)
                .setTextAlignment(TextAlignment.RIGHT)
                .add(new Paragraph("PRESUPUESTO")
                        .setFontColor(KT_NARANJA)
                        .simulateBold()
                        .setFontSize(10)
                        .setCharacterSpacing(3f)
                        .setMargin(0))
                .add(new Paragraph(numero)
                        .simulateBold()
                        .setFontSize(30)
                        .setFontColor(ColorConstants.WHITE)
                        .setMargin(0)
                        .setMarginTop(2));
        if (!fechaCorta.isEmpty()) {
            der.add(new Paragraph(fechaCorta)
                    .setFontColor(ColorConstants.LIGHT_GRAY)
                    .setFontSize(9)
                    .setCharacterSpacing(1f)
                    .setMargin(0)
                    .setMarginTop(2));
        }

        header.addCell(izq);
        header.addCell(der);
        doc.add(header);

        // 3) Banda inferior fina (eco del gradient — refuerza el "letterhead").
        Table cierre = new Table(UnitValue.createPercentArray(new float[]{1f}))
                .useAllAvailableWidth()
                .setBorder(Border.NO_BORDER);
        cierre.addCell(new Cell().setHeight(2.5f).setBackgroundColor(KT_NARANJA)
                .setBorder(Border.NO_BORDER));
        doc.add(cierre);
    }

    // =====================================================
    // Card del cliente — solo (nombre) | (fecha y hora).
    // El logo ya aparece en el header, así que esta card no lo repite.
    // No incluimos el teléfono: la card crecía verticalmente y, en modo
    // cotización individual, empujaba el card del producto a una segunda
    // hoja dejando la primera con el header + datos del cliente sueltos.
    // El teléfono queda registrado en la BD para seguimiento comercial,
    // pero no se imprime en el PDF que ve el cliente.
    // =====================================================
    private void agregarCardCliente(Document doc, PresupuestoComercial p) {
        // Padding/margen recortados: este card es informativo (CLIENTE | FECHA)
        // y antes ocupaba ~80px por el padding 16+16 + valor en 13pt. Bajándolo
        // a padding 8 + valor en 11pt queda en ~50px, liberando espacio para
        // que el card del producto entre completo en la primera página en
        // modo cotización individual (la queja típica era que una forma de
        // pago quedaba en una hoja extra).
        Div card = new Div()
                .setMarginTop(8)
                .setBackgroundColor(ColorConstants.WHITE)
                .setBorder(new SolidBorder(GRIS_LINEA, 1f))
                .setBorderRadius(new BorderRadius(10f))
                .setPadding(8);

        Table grid = new Table(UnitValue.createPercentArray(new float[]{1.8f, 1f}))
                .useAllAvailableWidth()
                .setBorder(Border.NO_BORDER);

        // Columna 1: nombre del cliente.
        Cell celdaCliente = new Cell()
                .setBorder(Border.NO_BORDER)
                .setVerticalAlignment(VerticalAlignment.MIDDLE)
                .setPadding(2);
        celdaCliente.add(labelChico("CLIENTE"));
        celdaCliente.add(new Paragraph(safe(p.getClienteNombre(), "—"))
                .simulateBold()
                .setFontSize(11)
                .setFontColor(GRIS_OSCURO)
                .setMargin(0));
        grid.addCell(celdaCliente);

        // Columna 2: fecha y hora.
        Cell celdaMeta = new Cell()
                .setBorder(Border.NO_BORDER)
                .setVerticalAlignment(VerticalAlignment.MIDDLE)
                .setPadding(2);
        celdaMeta.add(labelChico("FECHA Y HORA"));
        String fechaHora = p.getCreadoAt() != null
                ? p.getCreadoAt().atZone(TZ_AR).format(FECHA_HORA_FMT)
                : "";
        celdaMeta.add(new Paragraph(fechaHora)
                .simulateBold()
                .setFontSize(11)
                .setFontColor(GRIS_OSCURO)
                .setMargin(0));
        grid.addCell(celdaMeta);

        card.add(grid);
        doc.add(card);
    }

    // =====================================================
    // Detalle de productos
    // =====================================================
    private void agregarTablaDetalle(Document doc,
                                     List<GenerarPresupuestoRequestDTO.Item> items,
                                     ImageData sinImagen) {
        Div seccion = new Div()
                .setMarginTop(12)
                .setBackgroundColor(ColorConstants.WHITE)
                .setBorder(new SolidBorder(GRIS_LINEA, 1f))
                .setBorderRadius(new BorderRadius(12f))
                .setPadding(14);

        Paragraph tituloSeccion = new Paragraph()
                .add(buntoColor(KT_NARANJA))
                .add("  DETALLE DE PRODUCTOS")
                .simulateBold()
                .setFontSize(10)
                .setCharacterSpacing(1.5f)
                .setFontColor(GRIS_OSCURO)
                .setMargin(0)
                .setMarginBottom(8);
        seccion.add(tituloSeccion);

        // Columnas: foto | código | descripción | cant | precio | desc | total
        Table tabla = new Table(UnitValue.createPercentArray(
                new float[]{0.8f, 0.9f, 2.6f, 0.55f, 0.95f, 0.6f, 1.05f}))
                .useAllAvailableWidth()
                .setBorder(Border.NO_BORDER);

        // Cabecera
        tabla.addHeaderCell(celdaHeader(""));
        tabla.addHeaderCell(celdaHeader("CÓDIGO"));
        tabla.addHeaderCell(celdaHeader("DESCRIPCIÓN").setTextAlignment(TextAlignment.LEFT));
        tabla.addHeaderCell(celdaHeader("CANT."));
        tabla.addHeaderCell(celdaHeader("PRECIO").setTextAlignment(TextAlignment.RIGHT));
        tabla.addHeaderCell(celdaHeader("DESC.").setTextAlignment(TextAlignment.RIGHT));
        tabla.addHeaderCell(celdaHeader("TOTAL").setTextAlignment(TextAlignment.RIGHT));

        for (GenerarPresupuestoRequestDTO.Item it : items) {
            BigDecimal cantidad = it.cantidad() == null ? BigDecimal.ZERO : it.cantidad();
            BigDecimal precioConIva = it.precioConIva() == null ? BigDecimal.ZERO : it.precioConIva();
            BigDecimal porcIva = it.porcIva() == null ? BigDecimal.valueOf(21) : it.porcIva();
            BigDecimal desc = it.descuentoPorcentaje() == null ? BigDecimal.ZERO : it.descuentoPorcentaje();
            // Convertimos a precio SIN IVA — es el precio que el operador ve
            // al escanear y el que se muestra al cliente como referencia
            // comercial. Las formas de pago aplican IVA al facturar si
            // corresponde (ej. "Transferencia con IVA").
            BigDecimal divisor = BigDecimal.ONE.add(porcIva.movePointLeft(2));
            BigDecimal precio = precioConIva.divide(divisor, 4, RoundingMode.HALF_UP);
            BigDecimal precioConDesc = precio.multiply(
                    BigDecimal.ONE.subtract(desc.movePointLeft(2)));
            BigDecimal totalLinea = precioConDesc.multiply(cantidad);

            // Foto
            Cell celdaFoto = new Cell()
                    .setBorder(Border.NO_BORDER)
                    .setPadding(6)
                    .setVerticalAlignment(VerticalAlignment.MIDDLE)
                    .setHorizontalAlignment(HorizontalAlignment.CENTER);
            Image img = cargarImagenProducto(it.sku(), 48f);
            // Si no hay foto local, mostramos el placeholder genérico para
            // que la columna no quede vacía y la fila luzca completa.
            if (img == null && sinImagen != null) {
                img = new Image(sinImagen);
            }
            if (img != null) {
                img.setAutoScale(false);
                img.scaleToFit(48, 48);
                img.setHorizontalAlignment(HorizontalAlignment.CENTER);
                celdaFoto.add(img);
            }
            tabla.addCell(celdaFoto);

            // Código (pill)
            Cell celdaCodigo = new Cell()
                    .setBorder(Border.NO_BORDER)
                    .setPadding(6)
                    .setVerticalAlignment(VerticalAlignment.MIDDLE)
                    .add(new Paragraph(safe(it.sku(), "—"))
                            .simulateBold()
                            .setFontSize(9)
                            .setBackgroundColor(GRIS_CLARO)
                            .setFontColor(KT_AZUL_CODIGO_TEXTO)
                            .setBorderRadius(new BorderRadius(10f))
                            .setPaddings(2, 6, 2, 6)
                            .setTextAlignment(TextAlignment.CENTER)
                            .setMargin(0));
            tabla.addCell(celdaCodigo);

            // Descripción
            Cell celdaDesc = new Cell()
                    .setBorder(Border.NO_BORDER)
                    .setPadding(6)
                    .setVerticalAlignment(VerticalAlignment.MIDDLE)
                    .add(new Paragraph(safe(it.descripcion(), "—"))
                            .simulateBold()
                            .setFontSize(10)
                            .setFontColor(GRIS_OSCURO)
                            .setMargin(0));
            tabla.addCell(celdaDesc);

            // Cantidad
            Cell celdaCant = new Cell()
                    .setBorder(Border.NO_BORDER)
                    .setPadding(6)
                    .setTextAlignment(TextAlignment.CENTER)
                    .setVerticalAlignment(VerticalAlignment.MIDDLE)
                    .add(new Paragraph(formatCantidad(cantidad))
                            .simulateBold()
                            .setFontSize(11)
                            .setFontColor(KT_AZUL_CODIGO_TEXTO)
                            .setMargin(0));
            tabla.addCell(celdaCant);

            // Producto sin precio cargado: mostramos "Consultar" en las
            // columnas de Precio / Total en lugar de "$ 0" — comunica al
            // cliente que tiene que pedir cotización para este ítem.
            boolean sinPrecio = precio.signum() <= 0;

            // Precio
            Cell celdaPrecio = new Cell()
                    .setBorder(Border.NO_BORDER)
                    .setPadding(6)
                    .setTextAlignment(TextAlignment.RIGHT)
                    .setVerticalAlignment(VerticalAlignment.MIDDLE);
            if (sinPrecio) {
                celdaPrecio.add(new Paragraph("Consultar")
                        .simulateBold()
                        .setFontSize(9)
                        .setFontColor(KT_NARANJA)
                        .setMargin(0));
            } else {
                celdaPrecio.add(new Paragraph(formatPesos(precio))
                        .setFontSize(10)
                        .setFontColor(GRIS_OSCURO)
                        .setMargin(0));
            }
            tabla.addCell(celdaPrecio);

            // Descuento %
            Cell celdaDescuento = new Cell()
                    .setBorder(Border.NO_BORDER)
                    .setPadding(6)
                    .setTextAlignment(TextAlignment.RIGHT)
                    .setVerticalAlignment(VerticalAlignment.MIDDLE);
            if (!sinPrecio && desc.signum() > 0) {
                celdaDescuento.add(new Paragraph(formatPorcentaje(desc) + "%")
                        .simulateBold()
                        .setFontSize(10)
                        .setFontColor(VERDE_PRECIO)
                        .setMargin(0));
            } else {
                celdaDescuento.add(new Paragraph("—")
                        .setFontSize(10)
                        .setFontColor(GRIS_MEDIO)
                        .setMargin(0));
            }
            tabla.addCell(celdaDescuento);

            // Total línea
            Cell celdaTotal = new Cell()
                    .setBorder(Border.NO_BORDER)
                    .setPadding(6)
                    .setTextAlignment(TextAlignment.RIGHT)
                    .setVerticalAlignment(VerticalAlignment.MIDDLE);
            if (sinPrecio) {
                celdaTotal.add(new Paragraph("Consultar")
                        .simulateBold()
                        .setFontSize(9)
                        .setFontColor(KT_NARANJA)
                        .setMargin(0));
            } else {
                celdaTotal.add(new Paragraph(formatPesos(totalLinea))
                        .simulateBold()
                        .setFontSize(11)
                        .setFontColor(GRIS_OSCURO)
                        .setMargin(0));
            }
            tabla.addCell(celdaTotal);
        }

        seccion.add(tabla);
        doc.add(seccion);
    }

    /**
     * Card de totales alineada a la derecha. Layout:
     *   <ul>
     *     <li>Sin descuentos → solo "Total s/IVA: $X" destacado.</li>
     *     <li>Con descuentos individuales → "Subtotal s/IVA", "Descuento (%)
     *         -$X", línea separadora, "Total s/IVA: $X" destacado.</li>
     *   </ul>
     * El % de descuento mostrado es el EFECTIVO calculado como
     * {@code (subtotalBruto - total) / subtotalBruto × 100} — coincide con
     * el descuento individual cuando todos los ítems tienen el mismo, y es
     * un promedio ponderado cuando difieren.
     */
    private void agregarCardTotal(Document doc, BigDecimal subtotalBrutoArg,
                                  BigDecimal totalSinIvaArg) {
        BigDecimal totalSinIva = totalSinIvaArg == null
                ? BigDecimal.ZERO
                : totalSinIvaArg;
        BigDecimal subtotalBruto = subtotalBrutoArg == null
                ? totalSinIva
                : subtotalBrutoArg;
        BigDecimal ahorro = subtotalBruto.subtract(totalSinIva);

        Div card = new Div()
                .setMarginTop(8)
                .setBackgroundColor(GRIS_CLARO)
                .setBorderRadius(new BorderRadius(10f))
                .setPadding(12)
                .setHorizontalAlignment(HorizontalAlignment.RIGHT)
                .setWidth(UnitValue.createPercentValue(45));

        if (ahorro.signum() > 0 && subtotalBruto.signum() > 0) {
            BigDecimal porcEfectivo = ahorro.multiply(BigDecimal.valueOf(100))
                    .divide(subtotalBruto, 2, RoundingMode.HALF_UP);

            card.add(filaDesglose("Subtotal s/IVA", formatPesos(subtotalBruto), false, false));
            card.add(filaDesglose(
                    "Descuento (" + formatPorcentaje(porcEfectivo) + "%)",
                    "-" + formatPesos(ahorro), false, true));
            card.add(new Div().setHeight(1).setBackgroundColor(GRIS_LINEA)
                    .setMarginTop(4).setMarginBottom(4));
        }

        card.add(filaDesglose("Total s/IVA", formatPesos(totalSinIva), true, false));
        doc.add(card);
    }

    private Table filaDesglose(String label, String valor, boolean destacado, boolean ahorro) {
        Table fila = new Table(UnitValue.createPercentArray(new float[]{1.4f, 1f}))
                .useAllAvailableWidth()
                .setBorder(Border.NO_BORDER);

        Paragraph labelP = new Paragraph(label)
                .setFontSize(destacado ? 12 : 9)
                .setFontColor(destacado ? GRIS_OSCURO : GRIS_MEDIO)
                .setMargin(0);
        if (destacado) labelP.simulateBold();

        Paragraph valorP = new Paragraph(valor)
                .simulateBold()
                .setFontSize(destacado ? 16 : 10)
                .setFontColor(destacado ? KT_MARRON : (ahorro ? VERDE_PRECIO : GRIS_OSCURO))
                .setTextAlignment(TextAlignment.RIGHT)
                .setMargin(0);

        fila.addCell(new Cell().setBorder(Border.NO_BORDER).setPadding(2).add(labelP));
        fila.addCell(new Cell().setBorder(Border.NO_BORDER).setPadding(2).add(valorP));
        return fila;
    }

    // =====================================================
    // Formas de pago — cards en grid de 3 columnas
    // =====================================================
    private void agregarFormasPago(Document doc,
            List<GenerarPresupuestoRequestDTO.FormaPagoSnapshot> formas) {
        if (formas == null || formas.isEmpty()) return;

        // keepTogether evita que el contenedor con borde se parta entre dos
        // páginas: si lo que queda libre al final de la página actual no
        // alcanza, iText empuja toda la sección a la siguiente. Sin esto, la
        // segunda mitad aparecía sin título ni borde porque iText no repinta
        // el decoration del Div al cruzar página.
        Div seccion = new Div()
                .setMarginTop(14)
                .setBackgroundColor(ColorConstants.WHITE)
                .setBorder(new SolidBorder(GRIS_LINEA, 1f))
                .setBorderRadius(new BorderRadius(12f))
                .setPadding(14)
                .setKeepTogether(true);

        Paragraph titulo = new Paragraph()
                .add(buntoColor(VERDE_PRECIO))
                .add("  FORMAS DE PAGO DISPONIBLES")
                .simulateBold()
                .setFontSize(10)
                .setCharacterSpacing(1.5f)
                .setFontColor(GRIS_OSCURO)
                .setMargin(0)
                .setMarginBottom(10);
        seccion.add(titulo);

        final int COLUMNAS = 3;
        // Identifica la forma con menor precio (misma moneda local) para
        // resaltarla con el badge "MEJOR PRECIO".
        int indiceMejorPrecio = indiceMejorPrecio(formas);

        Table grid = new Table(UnitValue.createPercentArray(new float[]{1f, 1f, 1f}))
                .useAllAvailableWidth()
                .setBorder(Border.NO_BORDER);

        for (int i = 0; i < formas.size(); i++) {
            Cell celda = new Cell()
                    .setBorder(Border.NO_BORDER)
                    .setPadding(5)
                    .add(buildCardFormaPago(formas.get(i),
                            BORDE_FORMA_PAGO[i % BORDE_FORMA_PAGO.length],
                            i == indiceMejorPrecio));
            grid.addCell(celda);
        }
        // Completar la última fila con celdas vacías para que el grid quede prolijo.
        int faltantes = (COLUMNAS - (formas.size() % COLUMNAS)) % COLUMNAS;
        for (int j = 0; j < faltantes; j++) {
            grid.addCell(new Cell().setBorder(Border.NO_BORDER));
        }

        seccion.add(grid);
        doc.add(seccion);
    }

    /**
     * Devuelve el índice (en {@code formas}) de la forma con precio más bajo,
     * ignorando las que están en moneda extranjera (USD) para no comparar
     * peras con manzanas. -1 si no hay una clara ganadora (todas iguales o
     * lista de un solo elemento).
     */
    private static int indiceMejorPrecio(
            List<GenerarPresupuestoRequestDTO.FormaPagoSnapshot> formas) {
        if (formas == null || formas.size() <= 1) return -1;
        int idx = -1;
        BigDecimal min = null;
        for (int i = 0; i < formas.size(); i++) {
            GenerarPresupuestoRequestDTO.FormaPagoSnapshot f = formas.get(i);
            if (f.precioFinal() == null || f.precioFinal().signum() <= 0) continue;
            if (esTextoValido(f.monedaSimbolo())) continue;
            if (min == null || f.precioFinal().compareTo(min) < 0) {
                min = f.precioFinal();
                idx = i;
            }
        }
        // Si el "mínimo" empata con otras formas, no marcamos a nadie.
        if (idx == -1 || min == null) return -1;
        int empates = 0;
        for (GenerarPresupuestoRequestDTO.FormaPagoSnapshot f : formas) {
            if (f.precioFinal() != null && !esTextoValido(f.monedaSimbolo())
                    && f.precioFinal().compareTo(min) == 0) {
                empates++;
            }
        }
        return empates > 1 ? -1 : idx;
    }

    private Div buildCardFormaPago(GenerarPresupuestoRequestDTO.FormaPagoSnapshot f,
                                   Color borde, boolean esMejorPrecio) {
        // Wrapper que combina la barra superior coloreada + la card de contenido.
        // No usamos setBorderTop sobre la card porque iText no respeta bien la
        // combinación de bordes-distintos-por-lado con esquinas redondeadas
        // (el redondeado se pierde / la barra no toca los costados).
        Div wrapper = new Div()
                .setBackgroundColor(GRIS_CLARO)
                .setBorderRadius(new BorderRadius(10f))
                .setMinHeight(120)
                .setKeepTogether(true);

        // Barra superior — Div con fondo de color y alto fijo. Solo las dos
        // esquinas superiores redondeadas para que encaje con el wrapper. Las
        // inferiores quedan rectas porque va pegada al contenido.
        //
        // Para la card ganadora ("Mejor precio") pintamos la barra de verde
        // en lugar del color rotativo asignado por índice — así el
        // destacado se nota sin romper la armonía de la card (un borde
        // alrededor encima de la barra coloreada queda visualmente sucio).
        Color colorBarra = esMejorPrecio ? VERDE_PRECIO : borde;
        Div barra = new Div()
                .setHeight(esMejorPrecio ? 7f : 5f)
                .setBackgroundColor(colorBarra)
                .setBorderTopLeftRadius(new BorderRadius(10f))
                .setBorderTopRightRadius(new BorderRadius(10f));
        wrapper.add(barra);

        // Contenido (textos) — padding aplicado solo acá para que la barra
        // quede pegada al tope.
        Div contenido = new Div().setPadding(12).setPaddingTop(10);

        // Badge "MEJOR PRECIO" — pill verde con texto blanco. Va arriba del
        // nombre para que sea lo primero que el ojo del cliente capte.
        //
        // Sin caracteres Unicode (iText default font usa WinAnsi y los chars
        // como ✓ ★ etc. no renderizan; sólo dejamos el texto).
        //
        // Width fijo en puntos (≈70pt) en lugar de "50% del card" — con el
        // width porcentual el texto se rompía en dos líneas ("MEJOR" arriba,
        // "PRECIO" abajo) porque la franja era más angosta que el texto a 7pt.
        // Texto centrado dentro del pill para que se vea balanceado.
        if (esMejorPrecio) {
            contenido.add(new Paragraph("MEJOR PRECIO")
                    .simulateBold()
                    .setFontSize(7)
                    .setCharacterSpacing(0.8f)
                    .setFontColor(ColorConstants.WHITE)
                    .setBackgroundColor(VERDE_PRECIO)
                    .setBorderRadius(new BorderRadius(10f))
                    .setPaddings(2, 8, 2, 8)
                    .setTextAlignment(TextAlignment.CENTER)
                    .setHorizontalAlignment(HorizontalAlignment.LEFT)
                    .setMargin(0)
                    .setMarginBottom(6)
                    .setWidth(70f));
        }

        // Nombre — sin íconos. La fuente default de iText (Helvetica con
        // codificación WinAnsi) no soporta caracteres Unicode más allá de
        // Latin-1, así que los íconos solo se muestran en el frontend.
        contenido.add(new Paragraph(safe(f.nombre(), "—"))
                .simulateBold()
                .setFontSize(11)
                .setFontColor(GRIS_OSCURO)
                .setMargin(0)
                .setMarginBottom(2));

        // Indicación de IVA siempre visible cuando el snapshot tiene el flag
        // poblado. Antes solo aparecía "s/IVA" si la forma NO incluía IVA
        // (vía f.descripcion()), pero las que sí lo incluían quedaban sin
        // aclaración y el cliente no podía distinguir si el precio mostrado
        // ya tenía IVA o si se le sumaba aparte. Ahora marcamos siempre
        // "c/IVA" o "s/IVA" debajo del nombre.
        if (f.aplicaIva() != null) {
            contenido.add(new Paragraph(f.aplicaIva() ? "c/IVA" : "s/IVA")
                    .setFontSize(8)
                    .setFontColor(GRIS_MEDIO)
                    .setMargin(0)
                    .setMarginBottom(2));
        }

        // Limpiamos "s/IVA" si viene dentro de la descripción (presupuestos
        // viejos lo guardaban como parte del string). Ahora se renderiza
        // siempre arriba (c/IVA o s/IVA), así que duplicarlo en la descripción
        // queda redundante.
        String desc = f.descripcion();
        if (desc != null) {
            desc = desc.replaceAll("\\s*·\\s*s/IVA", "")
                    .replaceAll("^s/IVA\\s*·\\s*", "")
                    .replaceAll("^s/IVA$", "")
                    .trim();
        }
        if (esTextoValido(desc)) {
            contenido.add(new Paragraph(desc)
                    .setFontSize(8)
                    .setFontColor(GRIS_MEDIO)
                    .setMultipliedLeading(1.2f)
                    .setMargin(0)
                    .setMarginBottom(6));
        }

        String simbolo = esTextoValido(f.monedaSimbolo()) ? f.monedaSimbolo() : null;
        String precioStr = simbolo != null
                ? formatNumero(f.precioFinal()) + " " + simbolo
                : formatPesos(f.precioFinal());

        contenido.add(new Paragraph(precioStr)
                .simulateBold()
                .setFontSize(18)
                .setFontColor(KT_MARRON)
                .setMargin(0));

        if (f.cantidadCuotas() != null && f.cantidadCuotas() > 1) {
            BigDecimal cuota = f.precioFinal().divide(
                    BigDecimal.valueOf(f.cantidadCuotas()), 2, RoundingMode.HALF_UP);
            contenido.add(new Paragraph(
                    f.cantidadCuotas() + " cuotas de " + formatPesos(cuota))
                    .setFontSize(8)
                    .setFontColor(GRIS_MEDIO)
                    .setMargin(0)
                    .setMarginTop(3));
        }

        wrapper.add(contenido);
        return wrapper;
    }

    // =====================================================
    // Observaciones
    // =====================================================
    private void agregarObservaciones(Document doc, GenerarPresupuestoRequestDTO datos) {
        if (!esTextoValido(datos.observaciones())) return;
        // keepTogether evita que el card de observaciones se parta entre dos
        // páginas. Si no entra al final de la última hoja, se mueve completo
        // a una hoja final de cierre.
        Div card = new Div()
                .setMarginTop(12)
                .setBackgroundColor(GRIS_CLARO)
                .setBorderRadius(new BorderRadius(8f))
                .setPadding(10)
                .setKeepTogether(true);
        card.add(new Paragraph("OBSERVACIONES")
                .simulateBold()
                .setFontSize(9)
                .setCharacterSpacing(1.5f)
                .setFontColor(GRIS_MEDIO)
                .setMargin(0)
                .setMarginBottom(4));
        card.add(new Paragraph(datos.observaciones())
                .setFontSize(10)
                .setFontColor(GRIS_OSCURO)
                .setMultipliedLeading(1.3f)
                .setMargin(0));
        doc.add(card);
    }

    // =====================================================
    // Helpers
    // =====================================================

    /** Precio unitario SIN IVA con descuento individual aplicado. Coincide
     *  con el precio "Efectivo s/IVA" de las cards de formas de pago dividido
     *  por la cantidad — útil para que el cliente pueda calcular fácil cuánto
     *  le sale agregar o quitar unidades. */
    private static BigDecimal precioUnitarioSinIva(GenerarPresupuestoRequestDTO.Item item) {
        BigDecimal precioConIva = item.precioConIva() == null ? BigDecimal.ZERO : item.precioConIva();
        BigDecimal porcIva = item.porcIva() == null ? BigDecimal.valueOf(21) : item.porcIva();
        BigDecimal desc = item.descuentoPorcentaje() == null ? BigDecimal.ZERO : item.descuentoPorcentaje();
        BigDecimal precioConDesc = precioConIva.multiply(
                BigDecimal.ONE.subtract(desc.movePointLeft(2)));
        BigDecimal divisor = BigDecimal.ONE.add(porcIva.movePointLeft(2));
        return precioConDesc.divide(divisor, 2, RoundingMode.HALF_UP);
    }

    /** Precio de lista unitario SIN IVA (sin aplicar el descuento individual).
     *  Se usa para mostrar el precio tachado encima del precio con descuento
     *  cuando el ítem tiene un descuento — refuerza visualmente el ahorro. */
    private static BigDecimal precioListaSinIva(GenerarPresupuestoRequestDTO.Item item) {
        BigDecimal precioConIva = item.precioConIva() == null ? BigDecimal.ZERO : item.precioConIva();
        BigDecimal porcIva = item.porcIva() == null ? BigDecimal.valueOf(21) : item.porcIva();
        BigDecimal divisor = BigDecimal.ONE.add(porcIva.movePointLeft(2));
        return precioConIva.divide(divisor, 2, RoundingMode.HALF_UP);
    }

    /** Chip/pill compacto a partir de un String simple — wrapper sobre
     *  {@link #chip(Paragraph, Color, Color)}. */
    private static Cell chip(String texto, Color colorTexto, Color colorFondo) {
        return chip(new Paragraph(texto), colorTexto, colorFondo);
    }

    /** Chip/pill estándar (font 9, padding horizontal 10). */
    private static Cell chip(Paragraph contenido, Color colorTexto, Color colorFondo) {
        return chip(contenido, colorTexto, colorFondo, 9f, 10f);
    }

    /** Chip/pill con tamaño customizable. Permite hacer pills compactas (font
     *  más chico + menos padding horizontal) cuando el contenido es corto y
     *  queremos diferenciarla visualmente del resto. Texto en bold sobre un
     *  fondo pastel con esquinas redondeadas tipo pill. */
    private static Cell chip(Paragraph contenido, Color colorTexto, Color colorFondo,
                             float fontSize, float paddingHorizontal) {
        contenido
                .simulateBold()
                .setFontSize(fontSize)
                .setFontColor(colorTexto)
                .setBackgroundColor(colorFondo)
                .setBorderRadius(new BorderRadius(12f))
                .setPaddings(3, paddingHorizontal, 3, paddingHorizontal)
                .setTextAlignment(TextAlignment.CENTER)
                .setMargin(0);
        return new Cell()
                .setBorder(Border.NO_BORDER)
                .setPadding(3)
                .setTextAlignment(TextAlignment.CENTER)
                .add(contenido);
    }

    private static Cell celdaHeader(String texto) {
        return new Cell()
                .setBorder(Border.NO_BORDER)
                .setBorderBottom(new SolidBorder(GRIS_LINEA, 1f))
                .setPadding(6)
                .setTextAlignment(TextAlignment.CENTER)
                .add(new Paragraph(texto)
                        .setFontSize(8)
                        .setCharacterSpacing(1.5f)
                        .setFontColor(GRIS_MEDIO)
                        .simulateBold()
                        .setMargin(0));
    }

    private static Paragraph labelChico(String txt) {
        return new Paragraph(txt)
                .setFontSize(8)
                .setCharacterSpacing(1.2f)
                .setFontColor(GRIS_MEDIO)
                .setMargin(0);
    }

    private static Paragraph valorGrande(String txt) {
        return new Paragraph(txt)
                .simulateBold()
                .setFontSize(13)
                .setFontColor(GRIS_OSCURO)
                .setMargin(0);
    }

    /** Punto coloreado decorativo para títulos de sección (bullet circular). */
    private static IBlockElement buntoColor(Color c) {
        return new Paragraph("●")
                .setFontColor(c)
                .setFontSize(10)
                .setMargin(0);
    }

    /** Carga la imagen del producto preprocesada (recorte de bordes blancos +
     *  resize a la resolución útil + recompresión JPEG) vía {@link PdfImagenUtils}.
     *  Devuelve {@code null} si no hay imagen local — el caller aplica su fallback. */
    private Image cargarImagenProducto(String sku, float displaySizePt) {
        if (sku == null) return null;
        File archivo = imagenLocalService.buscar(sku).orElse(null);
        return PdfImagenUtils.cargarImagenProducto(archivo, null, displaySizePt);
    }

    private ImageData cargarRecurso(String resourcePath) {
        java.net.URL url = getClass().getResource(resourcePath);
        if (url == null) {
            log.warn("Recurso PDF no encontrado en classpath: {}", resourcePath);
            return null;
        }
        try {
            return ImageDataFactory.create(url.toExternalForm());
        } catch (Exception e) {
            log.warn("No se pudo cargar el recurso PDF {}: {}", resourcePath, e.getMessage());
            return null;
        }
    }

    private static String safe(String s, String fallback) {
        return s == null || s.isBlank() ? fallback : s;
    }

    private static boolean esTextoValido(String s) {
        return s != null && !s.isBlank();
    }

    private static String formatPesos(BigDecimal v) {
        if (v == null) return PESO_FMT.format(0);
        return PESO_FMT.format(v.doubleValue());
    }

    private static String formatNumero(BigDecimal v) {
        if (v == null) return "0";
        return String.valueOf(v.setScale(0, RoundingMode.HALF_UP).intValue());
    }

    private static String formatCantidad(BigDecimal cantidad) {
        if (cantidad == null) return "0";
        if (cantidad.stripTrailingZeros().scale() <= 0) {
            return cantidad.setScale(0, RoundingMode.UNNECESSARY).toPlainString();
        }
        return cantidad.stripTrailingZeros().toPlainString();
    }

    /** Formatea un porcentaje con coma decimal (es-AR) redondeado a 1 decimal:
     *  {@code 2.03 → "2"}, {@code 8.33 → "8,3"}, {@code 10.00 → "10"}.
     *  Limpia ceros sobrantes — un valor entero se muestra sin coma. */
    private static String formatPorcentaje(BigDecimal v) {
        if (v == null) return "0";
        BigDecimal r = v.setScale(1, RoundingMode.HALF_UP).stripTrailingZeros();
        if (r.scale() < 0) r = r.setScale(0, RoundingMode.UNNECESSARY);
        return r.toPlainString().replace('.', ',');
    }

    private static int porcMaxDescuento(BigDecimal totalConIva,
            List<GenerarPresupuestoRequestDTO.FormaPagoSnapshot> formas) {
        if (totalConIva == null || totalConIva.signum() == 0) return 0;
        BigDecimal min = totalConIva;
        for (GenerarPresupuestoRequestDTO.FormaPagoSnapshot f : formas) {
            if (f.precioFinal() != null && f.precioFinal().signum() > 0
                    && !esTextoValido(f.monedaSimbolo())
                    && f.precioFinal().compareTo(min) < 0) {
                min = f.precioFinal();
            }
        }
        BigDecimal ahorro = BigDecimal.ONE.subtract(min.divide(totalConIva, 4, RoundingMode.HALF_UP));
        return ahorro.multiply(BigDecimal.valueOf(100)).intValue();
    }

    private static String sanitizar(String s) {
        if (s == null) return "sin-nombre";
        String r = s.trim();
        if (r.isEmpty()) return "sin-nombre";
        r = java.text.Normalizer.normalize(r, java.text.Normalizer.Form.NFD)
                .replaceAll("\\p{InCombiningDiacriticalMarks}+", "");
        r = r.replaceAll("[^A-Za-z0-9_-]+", "-");
        r = r.replaceAll("-+", "-").replaceAll("^-|-$", "");
        if (r.isEmpty()) return "sin-nombre";
        if (r.length() > 40) r = r.substring(0, 40);
        return r;
    }

    // =====================================================
    // Background & footer (mismas piezas que el PDF de pedidos)
    // =====================================================
    private static class BackgroundHandler extends AbstractPdfDocumentEventHandler {
        private final ImageData bg;
        BackgroundHandler(ImageData bg) { this.bg = bg; }

        @Override
        protected void onAcceptedEvent(AbstractPdfDocumentEvent event) {
            try {
                if (bg == null) return;
                PdfPage page = ((PdfDocumentEvent) event).getPage();
                Rectangle area = page.getPageSize();
                PdfCanvas canvas = new PdfCanvas(
                        page.newContentStreamBefore(), page.getResources(), page.getDocument());
                canvas.addImageFittedIntoRectangle(bg, area, false);
            } catch (Exception ignored) {
                // background decorativo — si falla, el PDF sigue siendo válido
            }
        }
    }

    private static class FooterHandler extends AbstractPdfDocumentEventHandler {
        private final PdfDocument pdfDoc;
        private final ImageData logo;
        FooterHandler(PdfDocument pdfDoc, ImageData logo) { this.pdfDoc = pdfDoc; this.logo = logo; }

        @Override
        protected void onAcceptedEvent(AbstractPdfDocumentEvent event) {
            try {
                PdfPage page = ((PdfDocumentEvent) event).getPage();
                int pageNum = pdfDoc.getPageNumber(page);
                float pageWidth = page.getPageSize().getWidth();
                float y = 20f;
                float textX = pageWidth / 2f;
                float logoX = pageWidth / 2f - 40f;
                float logoW = 30f;
                float logoH = 25f;

                PdfCanvas pdfCanvas = new PdfCanvas(
                        page.newContentStreamAfter(), page.getResources(), pdfDoc);

                if (logo != null) {
                    Rectangle logoRect = new Rectangle(logoX, y - logoH / 2f, logoW, logoH);
                    pdfCanvas.addImageFittedIntoRectangle(logo, logoRect, false);
                }

                Rectangle textArea = new Rectangle(textX, y - 4f, pageWidth / 2f - 20f, 14f);
                try (Canvas canvas = new Canvas(pdfCanvas, textArea)) {
                    Paragraph p = new Paragraph("Página " + pageNum)
                            .setFontSize(10)
                            .setFontColor(KT_MARRON)
                            .setMargin(0);
                    canvas.add(p);
                }
            } catch (Exception ignored) {
                // footer decorativo — si falla, el PDF sigue siendo válido
            }
        }
    }
}
