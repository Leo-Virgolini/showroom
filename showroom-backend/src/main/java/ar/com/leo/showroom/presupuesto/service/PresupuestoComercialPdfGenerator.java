package ar.com.leo.showroom.presupuesto.service;

import ar.com.leo.showroom.catalogo.service.ImagenLocalService;
import ar.com.leo.showroom.common.pdf.KtPdfColores;
import ar.com.leo.showroom.common.pdf.PdfFormatoUtils;
import ar.com.leo.showroom.common.pdf.PdfImagenUtils;
import ar.com.leo.showroom.config.entity.EscalaDescuento;
import ar.com.leo.showroom.config.entity.FormaPago;
import ar.com.leo.showroom.config.service.EscalaDescuentoService;
import ar.com.leo.showroom.config.service.FormaPagoService;
import ar.com.leo.showroom.config.service.PrecioPerfilCalculator;
import ar.com.leo.showroom.pedido.entity.PedidoShowroom;
import ar.com.leo.showroom.pedido.entity.PedidoShowroomItem;
import ar.com.leo.showroom.presupuesto.dto.GenerarPresupuestoRequestDTO;
import ar.com.leo.showroom.presupuesto.entity.PresupuestoComercial;
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
import com.itextpdf.layout.element.IBlockElement;
import com.itextpdf.layout.element.Image;
import com.itextpdf.layout.element.Paragraph;
import com.itextpdf.layout.element.Table;
import com.itextpdf.layout.element.Text;
import com.itextpdf.layout.properties.BorderRadius;
import com.itextpdf.layout.properties.HorizontalAlignment;
import com.itextpdf.layout.properties.Property;
import com.itextpdf.layout.properties.TextAlignment;
import com.itextpdf.layout.properties.UnitValue;
import com.itextpdf.layout.properties.VerticalAlignment;
import com.itextpdf.layout.splitting.ISplitCharacters;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;

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

    // Tema KT (mismos colores que PresupuestoPdfGenerator de pedidos). Los
    // colores compartidos idénticos viven en KtPdfColores; acá quedan como
    // alias locales para no tocar el cuerpo del generador.
    private static final Color KT_NARANJA = KtPdfColores.KT_NARANJA;
    private static final Color KT_MARRON = KtPdfColores.KT_MARRON;
    private static final Color KT_AZUL_CODIGO_TEXTO = KtPdfColores.KT_AZUL_CODIGO_TEXTO;
    private static final Color VERDE_PRECIO = KtPdfColores.VERDE_PRECIO;
    private static final Color GRIS_OSCURO = KtPdfColores.GRIS_OSCURO;
    private static final Color GRIS_MEDIO = KtPdfColores.GRIS_MEDIO;
    private static final Color GRIS_CLARO = new DeviceRgb(243, 244, 246);
    private static final Color GRIS_LINEA = KtPdfColores.GRIS_LINEA;
    /** Fondo de las filas pares en la tabla de ítems de interés (zebra). Gris
     *  perceptible sobre el blanco; el pill del código (GRIS_CLARO, más claro)
     *  queda como un rectángulo apenas más claro y el texto azul se sigue
     *  leyendo sin problema. */
    private static final Color ZEBRA_FILA = new DeviceRgb(234, 237, 242);

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
     *  Sincronizado con .color-1..10 en presupuestos-page.scss. Centralizado
     *  en KtPdfColores (idéntico en cotización financiera). */
    private static final Color[] BORDE_FORMA_PAGO = KtPdfColores.BORDE_FORMA_PAGO;

    /** Paleta para las columnas de descuento del PDF de ítems de interés: un
     *  par (texto fuerte, fondo suave) por escalón. El encabezado y la badge
     *  del precio rebajado comparten color para que el cliente asocie de un
     *  vistazo cada columna con su descuento. Ciclan si hay más escalones que
     *  colores. */
    // Sin verde: ese color lo usa la columna PRECIO EFECTIVO y se confundiría
    // con el primer escalón.
    private static final Color[] DESC_FG = new Color[]{
            new DeviceRgb(29, 78, 216),    // azul
            new DeviceRgb(126, 34, 206),   // púrpura
            new DeviceRgb(180, 83, 9),     // ámbar
            new DeviceRgb(190, 24, 93),    // rosa
            new DeviceRgb(8, 145, 178),    // cian
    };
    private static final Color[] DESC_BG = new Color[]{
            new DeviceRgb(219, 234, 254),  // azul claro
            new DeviceRgb(243, 232, 255),  // púrpura claro
            new DeviceRgb(255, 237, 213),  // ámbar claro
            new DeviceRgb(252, 231, 243),  // rosa claro
            new DeviceRgb(207, 250, 254),  // cian claro
    };

    private static final ZoneId TZ_AR = ZoneId.of("America/Argentina/Buenos_Aires");
    private static final DateTimeFormatter FECHA_HORA_FMT = DateTimeFormatter.ofPattern("dd/MM/yyyy HH:mm");

    /** Split-characters que nunca permite cortar el texto: se aplica al pill del
     *  código para que un SKU largo no se parta en dos líneas dentro de la celda
     *  angosta — queda siempre en una sola línea. */
    private static final ISplitCharacters CODIGO_NO_SPLIT = (text, glyphPos) -> false;

    private final ImagenLocalService imagenLocalService;
    private final EscalaDescuentoService escalaDescuentoService;
    /** Fuente única de la lógica "IVA por rubro" (menaje vs maquinaria) y de la
     *  lista configurable de rubros de maquinaria. Reusada aquí para que la
     *  exclusión de descuentos por escala y el precio mostrado por línea sigan
     *  la misma regla que el showroom (scan/visor/carrito). */
    private final PrecioPerfilCalculator precioPerfilCalculator;
    private final FormaPagoService formaPagoService;

    /**
     * Rubros DUX a los que NO se les aplican los descuentos generales por escala
     * (regla de negocio confirmada por el dueño el 2026-05-29). Es la MISMA lista
     * configurable de rubros de maquinaria ({@code precios.rubros-sin-iva}), leída
     * vía {@link PrecioPerfilCalculator}. En la tabla de "ítems de interés" estas
     * filas muestran "—" en lugar de un precio rebajado para cada escalón. La
     * comparación es case-insensitive, trimeada y SIN diacríticos.
     */
    private boolean rubroExcluyeDescuentos(String rubro) {
        if (rubro == null) return false;
        return PrecioPerfilCalculator.esMaquinaria(
                rubro, precioPerfilCalculator.rubrosMaquinariaNormalizados());
    }

    public byte[] generar(PresupuestoComercial presupuesto,
                          GenerarPresupuestoRequestDTO datos) {
        return construir(presupuesto, datos, "PRESUPUESTO", "Precios sujetos a modificación", true, true);
    }

    /**
     * Construcción común del PDF, parametrizada para reusar el mismo layout en
     * dos contextos:
     * <ul>
     *   <li><b>Presupuesto comercial</b>: título "PRESUPUESTO", con número y con
     *       la sección de totales + formas de pago ({@link #generar}).</li>
     *   <li><b>Ítems de interés</b> (productos vistos en una sesión sin compra):
     *       título custom, sin número y sin totales/formas — solo header + card
     *       del cliente + tabla de productos ({@link #generarItemsDeInteres}).</li>
     * </ul>
     */
    private byte[] construir(PresupuestoComercial presupuesto,
                             GenerarPresupuestoRequestDTO datos,
                             String tituloHeader,
                             String subtituloHeader,
                             boolean mostrarNumero,
                             boolean mostrarTotalesYFormas) {
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
                agregarHeader(doc, presupuesto, logoHeader, tituloHeader, subtituloHeader, mostrarNumero);
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
                // Modo agregado: header + card cliente + tabla, todo en una hoja.
                // Presupuesto (mostrarTotalesYFormas=true): tabla con
                // cant/precio/desc/total + sección de totales y formas de pago.
                // Ítems de interés (false): tabla simple (solo el monto por
                // producto) y sin totales/formas — cada ítem va de a 1 y sin
                // descuento, así que esas columnas serían ruido.
                agregarHeader(doc, presupuesto, logoHeader, tituloHeader, subtituloHeader, mostrarNumero);
                agregarCardCliente(doc, presupuesto);
                if (mostrarTotalesYFormas) {
                    agregarTablaDetalle(doc, datos.items(), sinImagen);
                    agregarTotalesAgregado(doc, datos);
                    agregarFormasPago(doc, datos.formasPago(), datos.items());
                } else {
                    List<EscalaDescuento> escalones = escalaDescuentoService.listar();
                    agregarTablaItemsInteres(doc, datos.items(), sinImagen, escalones);
                    boolean hayItemExcluido = datos.items() != null
                            && datos.items().stream()
                                    .anyMatch(it -> rubroExcluyeDescuentos(it.rubro()));
                    agregarNotaPreciosEfectivo(doc, !escalones.isEmpty(), hayItemExcluido);
                    agregarNotaMediosPago(doc);
                }
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
    // Ítems de interés — PDF de productos vistos en una sesión sin compra.
    // Reusa el layout agregado del presupuesto (mismo look, PDF liviano) pero
    // con header "ÍTEMS DE INTERÉS" (sin número) y SIN totales/formas de pago:
    // no es una cotización cerrada, solo el registro de lo que miró el cliente.
    // =====================================================

    /**
     * PDF de "ítems de interés" con TODOS los productos escaneados en la sesión
     * — para sesiones ABANDONADAS (sin pedido).
     *
     * @return null si la sesión no tiene items escaneados.
     */
    public byte[] generarItemsDeInteres(SesionShowroom sesion) {
        return construirItemsDeInteres(
                sesion.getItems(), sesion.getNombre(), sesion.getIniciadaAt());
    }

    /**
     * PDF de "ítems de interés" con los productos que el cliente vio pero NO
     * compró — para el follow-up tras un pedido. Filtra de los scans de la
     * sesión los SKUs que terminaron en el pedido.
     *
     * @return null si el cliente compró todo lo que vio (no quedan sobrantes).
     */
    public byte[] generarItemsDeInteres(SesionShowroom sesion, PedidoShowroom pedido) {
        Set<String> comprados = new HashSet<>();
        if (pedido.getItems() != null) {
            for (PedidoShowroomItem it : pedido.getItems()) {
                if (it.getSku() != null) comprados.add(it.getSku());
            }
        }
        List<SesionScanItem> sobrantes = new ArrayList<>();
        if (sesion.getItems() != null) {
            for (SesionScanItem s : sesion.getItems()) {
                if (!comprados.contains(s.getSku())) sobrantes.add(s);
            }
        }
        return construirItemsDeInteres(sobrantes, sesion.getNombre(), sesion.getIniciadaAt());
    }

    /**
     * Construye el PDF de ítems de interés a partir de una lista de scans ya
     * resuelta (todos los de la sesión, o filtrada por lo comprado). Cada ítem
     * va con cantidad 1 y sin descuento — la sesión no captura esos datos (solo
     * SKU, descripción, precio e IVA del momento del scan).
     *
     * @return null si la lista viene vacía (no hay nada que mandar).
     */
    private byte[] construirItemsDeInteres(List<SesionScanItem> scans,
                                           String clienteNombre, Instant fechaSesion) {
        if (scans == null || scans.isEmpty()) return null;

        // Precio "predefinido" por ítem: el de la forma de pago destacada del
        // perfil del rubro (menaje al precio efectivo c/IVA, maquinaria s/IVA) —
        // mismo criterio que el scan/visor/presupuestador. Se calcula acá y viaja
        // como precioReferencia para que la tabla lo muestre sin recalcular. Sin
        // forma destacada, cae al precio de lista por rubro.
        FormaPago destacadaMenaje = formaPagoService.formaDestacada(false);
        FormaPago destacadaMaquinaria = formaPagoService.formaDestacada(true);
        List<GenerarPresupuestoRequestDTO.Item> items = new ArrayList<>(scans.size());
        for (SesionScanItem s : scans) {
            BigDecimal conIva = s.getPrecioConIva() == null ? BigDecimal.ZERO : s.getPrecioConIva();
            boolean esMaq = precioPerfilCalculator.esMaquinaria(s.getRubro());
            FormaPago forma = esMaq ? destacadaMaquinaria : destacadaMenaje;
            BigDecimal precioReferencia = forma != null
                    ? PrecioPerfilCalculator.calcularPrecioFinal(conIva, s.getPorcIva(),
                            PrecioPerfilCalculator.recargoPerfil(forma, esMaq),
                            PrecioPerfilCalculator.aplicaIvaPerfil(forma, esMaq))
                    : (esMaq ? PrecioPerfilCalculator.calcularSinIva(conIva, s.getPorcIva()) : conIva);
            items.add(new GenerarPresupuestoRequestDTO.Item(
                    s.getSku(),
                    s.getDescripcion(),
                    s.getRubro(),
                    BigDecimal.ONE,
                    conIva,
                    s.getPorcIva(),
                    BigDecimal.ZERO,
                    null,
                    precioReferencia));
        }

        GenerarPresupuestoRequestDTO datos = new GenerarPresupuestoRequestDTO(
                clienteNombre, null, null, null, null,
                BigDecimal.ZERO, Boolean.FALSE, items, List.of());

        // Stub con los únicos campos que usa el layout: nombre + fecha. id null
        // → el header no imprime número.
        PresupuestoComercial stub = PresupuestoComercial.builder()
                .clienteNombre(clienteNombre)
                .creadoAt(fechaSesion)
                .build();

        return construir(stub, datos, "ÍTEMS DE INTERÉS", "Productos que viste en tu visita", false, false);
    }

    /** Filename: items-de-interes-{cliente}-{idSesion}-ddMMyyyy.pdf. */
    public String nombreArchivoItemsDeInteres(SesionShowroom sesion) {
        String cliente = sanitizar(Optional.ofNullable(sesion.getNombre()).orElse(""));
        String fecha = sesion.getIniciadaAt() != null
                ? sesion.getIniciadaAt().atZone(TZ_AR).toLocalDate()
                        .format(DateTimeFormatter.ofPattern("ddMMyyyy"))
                : "";
        return "items-de-interes-" + cliente
                + (sesion.getId() != null ? "-" + sesion.getId() : "")
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
                .setPaddings(3, 12, 3, 12)
                .setTextAlignment(TextAlignment.CENTER)
                .setMarginTop(4)
                .setMarginBottom(2)
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
                BigDecimal precioFinalEfectivo = precioUnitarioEfectivo(item);
                String label = cantMayorAUno ? "P. unitario: " : "Precio: ";
                Paragraph contenido = new Paragraph()
                        .add(new Text(label + formatPesos(precioFinalEfectivo)));
                if (tieneDescuento) {
                    BigDecimal listaSinIva = precioListaEfectivo(item);
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
            // Régimen de IVA de ESTE ítem (una hoja = un producto): maquinaria
            // usa el perfil maquinaria de la forma, el resto el perfil menaje.
            boolean itemEsMaquinaria = precioPerfilCalculator.esMaquinaria(item.rubro());
            for (int i = 0; i < formasItem.size(); i++) {
                GenerarPresupuestoRequestDTO.FormaPagoSnapshot f = formasItem.get(i);
                Boolean badge = itemEsMaquinaria ? f.aplicaIvaMaquinaria() : f.aplicaIva();
                celdaFormas.add(buildFilaFormaPagoItem(
                        f,
                        BORDE_FORMA_PAGO[i % BORDE_FORMA_PAGO.length],
                        i == indiceMejor,
                        badge));
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
                                       Color borde, boolean esMejorPrecio, Boolean badgeIva) {
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
        // El régimen de IVA depende del producto, no de la forma de pago, así
        // que las cards de formas de pago no muestran badge "c/IVA"/"s/IVA"
        // (el precioFinal ya es correcto). El IVA se ve en la tabla de productos.
        // Limpiamos "s/IVA" si viene dentro de la descripción para no
        // duplicar el bloque de arriba (presupuestos viejos lo persistían).
        String desc = f.descripcion();
        if (desc != null) {
            desc = desc.replaceAll("\\s*·\\s*s/IVA", "")
                    .replaceAll("^s/IVA\\s*·\\s*", "")
                    .replaceAll("^s/IVA$", "")
                    // El "% de descuento" depende del perfil del producto; no se
                    // muestra a nivel forma. Limpiamos el texto de presupuestos
                    // viejos que lo guardaron en la descripción.
                    .replaceAll("\\s*·\\s*\\d+% de descuento", "")
                    .replaceAll("^\\d+% de descuento\\s*·\\s*", "")
                    .replaceAll("^\\d+% de descuento$", "")
                    // "N cuotas" es redundante con el nombre de la forma y con el
                    // detalle "N cuotas de $X" — lo limpiamos de presupuestos viejos.
                    .replaceAll("\\s*·\\s*\\d+ cuotas", "")
                    .replaceAll("^\\d+ cuotas\\s*·\\s*", "")
                    .replaceAll("^\\d+ cuotas$", "")
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
        java.util.Set<String> rubrosMaq = precioPerfilCalculator.rubrosMaquinariaNormalizados();
        BigDecimal subtotalBruto = BigDecimal.ZERO;
        BigDecimal totalNeto = BigDecimal.ZERO;
        for (GenerarPresupuestoRequestDTO.Item it : datos.items()) {
            BigDecimal cantidad = it.cantidad() == null ? BigDecimal.ZERO : it.cantidad();
            BigDecimal precioConIva = it.precioConIva() == null ? BigDecimal.ZERO : it.precioConIva();
            BigDecimal porcIva = it.porcIva() == null ? PrecioPerfilCalculator.IVA_DEFAULT : it.porcIva();
            BigDecimal desc = it.descuentoPorcentaje() == null ? BigDecimal.ZERO : it.descuentoPorcentaje();
            // Precio EFECTIVO (forma primaria), igual que la tabla de productos.
            // Fallback presupuestos viejos: precio de lista según rubro
            // (maquinaria sin IVA, resto con IVA).
            boolean esMaq = PrecioPerfilCalculator.esMaquinaria(it.rubro(), rubrosMaq);
            BigDecimal precioMostrado = it.precioReferencia() != null
                    ? it.precioReferencia()
                    : (esMaq
                        ? PrecioPerfilCalculator.calcularSinIva(precioConIva, porcIva)
                        : precioConIva);
            subtotalBruto = subtotalBruto.add(precioMostrado.multiply(cantidad));
            totalNeto = totalNeto.add(precioMostrado
                    .multiply(BigDecimal.ONE.subtract(desc.movePointLeft(2)))
                    .multiply(cantidad));
        }
        agregarCardTotal(doc,
                subtotalBruto.setScale(2, RoundingMode.HALF_UP),
                totalNeto.setScale(2, RoundingMode.HALF_UP));
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
    private void agregarHeader(Document doc, PresupuestoComercial p, ImageData logoHeader,
                               String tituloHeader, String subtituloHeader, boolean mostrarNumero) {
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
        // Padding y altura del logo comprimidos respecto a la versión inicial
        // para liberar espacio vertical en la primera hoja (el header sólo
        // aparece en la pág. 1 y empujaba el primer producto a romper a la
        // página 2 en modo cotización individual con varias formas de pago).
        Cell izq = new Cell()
                .setBorder(Border.NO_BORDER)
                .setVerticalAlignment(VerticalAlignment.MIDDLE)
                .setBackgroundColor(ColorConstants.WHITE)
                .setPaddings(4, 14, 4, 16);
        if (logoHeader != null) {
            Image logo = new Image(logoHeader);
            // Altura fija — el ancho lo ajusta iText con el aspect ratio
            // real del PNG, evitando deformación si en algún futuro se
            // reemplaza la imagen por otra de proporciones distintas.
            logo.setHeight(56f);
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

        // === Derecha: título + (opcional) "#N" + subtítulo en fondo marrón ===
        Cell der = new Cell()
                .setBorder(Border.NO_BORDER)
                .setVerticalAlignment(VerticalAlignment.MIDDLE)
                .setBackgroundColor(KT_MARRON)
                .setPaddings(8, 22, 8, 22)
                .setTextAlignment(TextAlignment.RIGHT)
                .add(new Paragraph(tituloHeader)
                        .setFontColor(KT_NARANJA)
                        .simulateBold()
                        .setFontSize(10)
                        .setCharacterSpacing(3f)
                        .setMargin(0));
        // El número solo aplica a presupuestos comerciales; en el PDF de ítems
        // de interés se omite (mostrarNumero=false). Sin id (preview/borrador)
        // mostramos "—" para preservar el layout histórico del presupuesto.
        if (mostrarNumero) {
            der.add(new Paragraph(p.getId() != null ? "#" + p.getId() : "—")
                    .simulateBold()
                    .setFontSize(26)
                    .setFontColor(ColorConstants.WHITE)
                    .setMargin(0)
                    .setMarginTop(2));
        }
        if (esTextoValido(subtituloHeader)) {
            der.add(new Paragraph(subtituloHeader)
                    .setFontColor(ColorConstants.LIGHT_GRAY)
                    .setFontSize(9)
                    .setCharacterSpacing(0.5f)
                    .setMargin(0)
                    .setMarginTop(mostrarNumero ? 2 : 6));
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
        celdaCliente.add(new Paragraph(safe(p.getClienteNombre(), "—"))
                .simulateBold()
                .setFontSize(11)
                .setFontColor(GRIS_OSCURO)
                .setMargin(0));
        grid.addCell(celdaCliente);

        // Columna 2: fecha y hora.
        // Si el presupuesto fue editado (modificadoAt != null), mostramos esa
        // fecha como principal — es la que refleja el contenido vigente del
        // PDF — y la creación original debajo en un tamaño menor, para que
        // el cliente sepa que el presupuesto fue actualizado.
        Cell celdaMeta = new Cell()
                .setBorder(Border.NO_BORDER)
                .setVerticalAlignment(VerticalAlignment.MIDDLE)
                .setPadding(2);
        boolean fueEditado = p.getModificadoAt() != null;
        celdaMeta.add(labelChico(fueEditado ? "ACTUALIZADO" : "FECHA Y HORA"));
        Instant fechaPrincipal = fueEditado ? p.getModificadoAt() : p.getCreadoAt();
        String fechaHora = fechaPrincipal != null
                ? fechaPrincipal.atZone(TZ_AR).format(FECHA_HORA_FMT)
                : "";
        celdaMeta.add(new Paragraph(fechaHora)
                .simulateBold()
                .setFontSize(11)
                .setFontColor(GRIS_OSCURO)
                .setMargin(0));
        if (fueEditado && p.getCreadoAt() != null) {
            celdaMeta.add(new Paragraph("Emitido " + p.getCreadoAt().atZone(TZ_AR).format(FECHA_HORA_FMT))
                    .setFontSize(7.5f)
                    .setFontColor(GRIS_LINEA)
                    .setMarginTop(1f)
                    .setMargin(0));
        }
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
        // El código va un poco más ancho que antes (1.15 vs 0.9) para que SKUs
        // largos no se partan en dos líneas dentro del pill.
        Table tabla = new Table(UnitValue.createPercentArray(
                new float[]{0.8f, 1.15f, 2.35f, 0.55f, 0.95f, 0.6f, 1.05f}))
                .useAllAvailableWidth()
                .setBorder(Border.NO_BORDER);

        // Cabecera
        tabla.addHeaderCell(celdaHeader(""));
        tabla.addHeaderCell(celdaHeader("CÓDIGO"));
        tabla.addHeaderCell(celdaHeader("DESCRIPCIÓN").setTextAlignment(TextAlignment.LEFT));
        tabla.addHeaderCell(celdaHeader("CANT."));
        // "PRECIO EFECTIVO" = precio de contado (sin financiación). El régimen
        // de IVA depende del rubro de cada ítem (s/IVA maquinaria, c/IVA el
        // resto), pero no se muestra el badge para no recargar la fila.
        tabla.addHeaderCell(celdaHeader("PRECIO EFECTIVO").setTextAlignment(TextAlignment.RIGHT));
        tabla.addHeaderCell(celdaHeader("DESC.").setTextAlignment(TextAlignment.RIGHT));
        tabla.addHeaderCell(celdaHeader("TOTAL").setTextAlignment(TextAlignment.RIGHT));

        // Set de rubros de maquinaria calculado una sola vez para todo el loop.
        Set<String> rubrosMaq = precioPerfilCalculator.rubrosMaquinariaNormalizados();

        int idx = 0;
        for (GenerarPresupuestoRequestDTO.Item it : items) {
            // Fondo zebra en las filas pares — mismo criterio que el PDF de ítems
            // de interés. Las impares quedan blancas (= fondo de la sección).
            Color fondoFila = (idx % 2 == 1) ? ZEBRA_FILA : ColorConstants.WHITE;
            idx++;
            BigDecimal cantidad = it.cantidad() == null ? BigDecimal.ZERO : it.cantidad();
            BigDecimal precioConIva = it.precioConIva() == null ? BigDecimal.ZERO : it.precioConIva();
            BigDecimal porcIva = it.porcIva() == null ? PrecioPerfilCalculator.IVA_DEFAULT : it.porcIva();
            BigDecimal desc = it.descuentoPorcentaje() == null ? BigDecimal.ZERO : it.descuentoPorcentaje();
            // Precio mostrado por línea SEGÚN EL RUBRO (misma lógica que el
            // showroom): maquinaria se cotiza SIN IVA; el resto (menaje) CON
            // IVA. La badge por celda aclara el régimen para que el cliente
            // sepa si el monto ya incluye IVA. En presupuestos mixtos cada
            // fila puede llevar régimen distinto.
            boolean esMaquinaria = PrecioPerfilCalculator.esMaquinaria(it.rubro(), rubrosMaq);
            // Precio mostrado = PRECIO EFECTIVO (forma primaria), ya según rubro.
            // Si el presupuesto es viejo y no trae `precioReferencia`, caemos al
            // precio de lista por rubro (maquinaria s/IVA, resto c/IVA).
            BigDecimal precio;
            if (it.precioReferencia() != null) {
                precio = it.precioReferencia();
            } else if (esMaquinaria) {
                precio = PrecioPerfilCalculator.calcularSinIva(precioConIva, porcIva);
            } else {
                precio = precioConIva;
            }
            BigDecimal precioConDesc = precio.multiply(
                    BigDecimal.ONE.subtract(desc.movePointLeft(2)));
            BigDecimal totalLinea = precioConDesc.multiply(cantidad);

            // Foto
            Cell celdaFoto = new Cell()
                    .setBackgroundColor(fondoFila)
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

            // Código (pill). CODIGO_NO_SPLIT + la columna más ancha evitan que
            // un SKU largo se parta en dos líneas dentro del pill.
            Paragraph codigoPill = new Paragraph(safe(it.sku(), "—"))
                    .simulateBold()
                    .setFontSize(9)
                    .setBackgroundColor(GRIS_CLARO)
                    .setFontColor(KT_AZUL_CODIGO_TEXTO)
                    .setBorderRadius(new BorderRadius(10f))
                    .setPaddings(2, 5, 2, 5)
                    .setTextAlignment(TextAlignment.CENTER)
                    .setMargin(0);
            codigoPill.setProperty(Property.SPLIT_CHARACTERS, CODIGO_NO_SPLIT);
            Cell celdaCodigo = new Cell()
                    .setBackgroundColor(fondoFila)
                    .setBorder(Border.NO_BORDER)
                    .setPadding(6)
                    .setVerticalAlignment(VerticalAlignment.MIDDLE)
                    .add(codigoPill);
            tabla.addCell(celdaCodigo);

            // Descripción
            Cell celdaDesc = new Cell()
                    .setBackgroundColor(fondoFila)
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
                    .setBackgroundColor(fondoFila)
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
                    .setBackgroundColor(fondoFila)
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
                    .setBackgroundColor(fondoFila)
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
                    .setBackgroundColor(fondoFila)
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
     * Tabla simplificada para el PDF de ítems de interés: foto | código |
     * descripción | total. Sin columnas de cantidad/precio/descuento — cada
     * ítem va de a 1 y sin descuento, así que "precio" y "total" coincidirían
     * y cantidad/descuento serían siempre "1"/"—". Mostramos solo el monto
     * (precio s/IVA) por producto, o "Consultar" si no tiene precio cargado.
     */
    private void agregarTablaItemsInteres(Document doc,
                                          List<GenerarPresupuestoRequestDTO.Item> items,
                                          ImageData sinImagen,
                                          List<EscalaDescuento> escalones) {
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

        // Escalones de descuento configurados (umbral + %, ordenados por umbral
        // ascendente): se agrega una columna por cada uno con el precio efectivo
        // rebajado ese %.
        int nDesc = escalones.size();

        // Columnas: foto | código | descripción | precio efectivo | (rebaja por
        // escalón). La descripción cede ancho a medida que se suman columnas de
        // descuento para que la tabla no se desborde del ancho útil A4.
        float wDesc = nDesc == 0 ? 3.15f : Math.max(1.7f, 3.15f - 0.45f * nDesc);
        float[] cols = new float[4 + nDesc];
        cols[0] = 0.7f;   // foto
        cols[1] = 1.05f;  // código
        cols[2] = wDesc;  // descripción
        cols[3] = 1.2f;   // precio efectivo
        for (int k = 0; k < nDesc; k++) cols[4 + k] = 1.2f;

        Table tabla = new Table(UnitValue.createPercentArray(cols))
                .useAllAvailableWidth()
                .setBorder(Border.NO_BORDER);

        // Cuando hay escalones, una fila de header superior agrupa sus columnas
        // bajo el rótulo "DESCUENTOS": una celda vacía con colspan sobre las 4
        // primeras columnas + el título con colspan sobre las de escalón.
        if (nDesc > 0) {
            tabla.addHeaderCell(new Cell(1, 4).setBorder(Border.NO_BORDER));
            tabla.addHeaderCell(new Cell(1, nDesc)
                    .setBorder(Border.NO_BORDER)
                    .setTextAlignment(TextAlignment.CENTER)
                    .setPaddingTop(4)
                    .setPaddingBottom(0)
                    .add(new Paragraph("DESCUENTOS")
                            .simulateBold()
                            .setFontSize(8)
                            .setCharacterSpacing(1.5f)
                            .setFontColor(GRIS_MEDIO)
                            .setMargin(0)));
        }

        tabla.addHeaderCell(celdaHeader(""));
        tabla.addHeaderCell(celdaHeader("CÓDIGO"));
        tabla.addHeaderCell(celdaHeader("DESCRIPCIÓN").setTextAlignment(TextAlignment.LEFT));
        tabla.addHeaderCell(celdaHeader("PRECIO EFECTIVO").setTextAlignment(TextAlignment.RIGHT));
        for (int k = 0; k < nDesc; k++) {
            EscalaDescuento e = escalones.get(k);
            tabla.addHeaderCell(celdaHeaderDescuento(
                    e.getPorcentaje(), e.getUmbralMin(),
                    DESC_FG[k % DESC_FG.length], DESC_BG[k % DESC_BG.length]));
        }

        // Set de rubros de maquinaria calculado una sola vez (la lista es
        // configurable; evitamos releerla/normalizarla por cada fila).
        Set<String> rubrosMaq = precioPerfilCalculator.rubrosMaquinariaNormalizados();

        int idx = 0;
        for (GenerarPresupuestoRequestDTO.Item it : items) {
            // Fondo zebra en las filas pares (2da, 4ta, …) — ayuda a seguir la
            // línea del producto hasta su precio en listas largas.
            Color fondoFila = (idx % 2 == 1) ? ZEBRA_FILA : null;
            idx++;

            // Precio efectivo de contado (forma destacada, según rubro): viene ya
            // calculado en el item (precioReferencia); fallback al precio de lista.
            BigDecimal precioReferencia = precioListaEfectivo(it);
            boolean sinPrecio = precioReferencia.signum() <= 0;
            /** Producto de un rubro excluido (ej. MAQUINAS INDUSTRIALES): la
             *  fila muestra el precio efectivo de contado pero las columnas
             *  de descuento por escala van en "—" para que no sugieran un
             *  precio rebajado que comercialmente no aplica. */
            boolean sinDescuentos = PrecioPerfilCalculator.esMaquinaria(it.rubro(), rubrosMaq);

            // Foto
            Cell celdaFoto = new Cell()
                    .setBorder(Border.NO_BORDER)
                    .setPadding(6)
                    .setVerticalAlignment(VerticalAlignment.MIDDLE)
                    .setHorizontalAlignment(HorizontalAlignment.CENTER);
            Image img = cargarImagenProducto(it.sku(), 48f);
            if (img == null && sinImagen != null) {
                img = new Image(sinImagen);
            }
            if (img != null) {
                img.setAutoScale(false);
                img.scaleToFit(48, 48);
                img.setHorizontalAlignment(HorizontalAlignment.CENTER);
                celdaFoto.add(img);
            }

            // Código (pill, una sola línea)
            Paragraph codigoPill = new Paragraph(safe(it.sku(), "—"))
                    .simulateBold()
                    .setFontSize(9)
                    .setBackgroundColor(GRIS_CLARO)
                    .setFontColor(KT_AZUL_CODIGO_TEXTO)
                    .setBorderRadius(new BorderRadius(10f))
                    .setPaddings(2, 5, 2, 5)
                    .setTextAlignment(TextAlignment.CENTER)
                    .setMargin(0);
            codigoPill.setProperty(Property.SPLIT_CHARACTERS, CODIGO_NO_SPLIT);
            Cell celdaCodigo = new Cell()
                    .setBorder(Border.NO_BORDER)
                    .setPadding(6)
                    .setVerticalAlignment(VerticalAlignment.MIDDLE)
                    .add(codigoPill);

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

            // Precio efectivo o "Consultar" si no tiene precio cargado.
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
                celdaPrecio.add(new Paragraph(formatPesos(precioReferencia))
                        .simulateBold()
                        .setFontSize(11)
                        .setFontColor(VERDE_PRECIO)
                        .setMargin(0));
            }

            // Precio efectivo rebajado por cada escalón. Misma base que la
            // columna "PRECIO EFECTIVO" (forma destacada), multiplicada por (1 - %/100).
            // Si el producto no tiene precio, la celda queda en "—" igual que
            // el resto.
            List<Cell> celdasRebaja = new ArrayList<>(nDesc);
            for (int k = 0; k < nDesc; k++) {
                EscalaDescuento e = escalones.get(k);
                Cell celdaRebaja = new Cell()
                        .setBorder(Border.NO_BORDER)
                        .setPadding(6)
                        .setTextAlignment(TextAlignment.CENTER)
                        .setVerticalAlignment(VerticalAlignment.MIDDLE);
                if (sinPrecio || sinDescuentos) {
                    celdaRebaja.add(new Paragraph("—")
                            .setFontSize(10)
                            .setFontColor(GRIS_MEDIO)
                            .setMargin(0));
                } else {
                    BigDecimal factor = BigDecimal.ONE.subtract(e.getPorcentaje().movePointLeft(2));
                    BigDecimal precioRebajado = precioReferencia.multiply(factor)
                            .setScale(2, RoundingMode.HALF_UP);
                    // Texto plano en el color del escalón — mismo color que la
                    // badge de su encabezado, para vincularlos visualmente.
                    celdaRebaja.add(new Paragraph(formatPesos(precioRebajado))
                            .simulateBold()
                            .setFontSize(10)
                            .setFontColor(DESC_FG[k % DESC_FG.length])
                            .setTextAlignment(TextAlignment.CENTER)
                            .setMargin(0));
                }
                celdasRebaja.add(celdaRebaja);
            }

            if (fondoFila != null) {
                celdaFoto.setBackgroundColor(fondoFila);
                celdaCodigo.setBackgroundColor(fondoFila);
                celdaDesc.setBackgroundColor(fondoFila);
                celdaPrecio.setBackgroundColor(fondoFila);
                for (Cell c : celdasRebaja) c.setBackgroundColor(fondoFila);
            }
            tabla.addCell(celdaFoto);
            tabla.addCell(celdaCodigo);
            tabla.addCell(celdaDesc);
            tabla.addCell(celdaPrecio);
            for (Cell c : celdasRebaja) tabla.addCell(c);
        }

        seccion.add(tabla);
        doc.add(seccion);
    }

    /**
     * Cintillo al pie del PDF de ítems de interés que invita a consultar otras
     * formas de pago — complementa el "PRECIO EFECTIVO" del encabezado para que
     * el cliente sepa que ese precio es el de contado y que hay alternativas.
     */
    /**
     * Aclaraciones finas debajo de la tabla de ítems de interés: los montos son
     * de contado y sin IVA, y (si hay escalones) cómo aplican los descuentos —
     * sobre el total de la compra y no acumulables, para que el cliente no
     * interprete que un solo producto ya accede al escalón mayor.
     */
    private void agregarNotaPreciosEfectivo(Document doc, boolean hayDescuentos,
                                            boolean hayItemExcluido) {
        doc.add(new Paragraph("Precios en efectivo")
                .setFontSize(9)
                .setCharacterSpacing(0.3f)
                .setFontColor(GRIS_MEDIO)
                .setTextAlignment(TextAlignment.CENTER)
                .setMarginTop(10)
                .setMarginBottom(0));
        if (hayDescuentos) {
            doc.add(new Paragraph(
                    "Descuentos sobre el total de la compra al alcanzar el monto indicado")
                    .setFontSize(8)
                    .setFontColor(GRIS_MEDIO)
                    .setTextAlignment(TextAlignment.CENTER)
                    .setMarginTop(2)
                    .setMarginBottom(0));
        }
        // Si alguno de los ítems pertenece a un rubro excluido (MAQUINAS
        // INDUSTRIALES) le explicamos al cliente por qué esas filas tienen
        // "—" en las columnas de descuento, en lugar de un precio rebajado.
        if (hayDescuentos && hayItemExcluido) {
            doc.add(new Paragraph(
                    "* Las máquinas industriales mantienen el precio de lista — "
                    + "los descuentos por monto no aplican a ese rubro.")
                    .setFontSize(8)
                    .setFontColor(GRIS_MEDIO)
                    .setTextAlignment(TextAlignment.CENTER)
                    .setMarginTop(2)
                    .setMarginBottom(0));
        }
    }

    private void agregarNotaMediosPago(Document doc) {
        Paragraph nota = new Paragraph()
                .setBackgroundColor(CHIP_BG_NARANJA)
                .setBorderRadius(new BorderRadius(20f))
                .setPaddings(10, 18, 10, 18)
                .setTextAlignment(TextAlignment.CENTER)
                .setMarginTop(14)
                .setHorizontalAlignment(HorizontalAlignment.CENTER)
                .setWidth(UnitValue.createPercentValue(72));

        // Íconos de medios de pago (banco · efectivo · tarjeta) inline. Si algún
        // PNG no carga, se omite ese ícono y el cintillo igual sale con el texto
        // — los íconos son decorativos.
        float iconSize = 14f;
        boolean algunIcono = false;
        for (String png : new String[]{
                "/images/medio-pago-banco.png",
                "/images/medio-pago-efectivo.png",
                "/images/medio-pago-tarjeta.png"}) {
            Image icono = cargarIcono(png, iconSize);
            if (icono != null) {
                nota.add(icono);
                nota.add(new Text("  "));
                algunIcono = true;
            }
        }
        if (algunIcono) nota.add(new Text("  "));

        nota.add(new Text("Consultá por nuestros otros medios de pago")
                .simulateBold()
                .setFontSize(11)
                .setFontColor(KT_MARRON));
        doc.add(nota);
    }

    /** Carga un ícono PNG del classpath como {@link Image} de iText, escalado a
     *  una altura de {@code size} pt manteniendo su proporción (la tarjeta es
     *  apaisada). Devuelve {@code null} si el recurso no existe — el caller
     *  decide el fallback (los íconos del cintillo son decorativos). */
    private Image cargarIcono(String resourcePath, float size) {
        ImageData data = cargarRecurso(resourcePath);
        if (data == null) return null;
        Image img = new Image(data);
        // Límite de ancho amplio → el alto manda y todos quedan a la misma altura.
        img.scaleToFit(1000f, size);
        return img;
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

            card.add(filaDesglose("Subtotal efectivo", formatPesos(subtotalBruto), false, false));
            card.add(filaDesglose(
                    "Descuento (" + formatPorcentaje(porcEfectivo) + "%)",
                    "-" + formatPesos(ahorro), false, true));
            card.add(new Div().setHeight(1).setBackgroundColor(GRIS_LINEA)
                    .setMarginTop(4).setMarginBottom(4));
        }

        // Total destacado — "efectivo" = precio de contado (sin financiación),
        // coherente con la columna "PRECIO EFECTIVO" de la tabla. Sin etiqueta
        // "s/IVA": el monto sigue el régimen de cada producto (maquinaria s/IVA,
        // resto c/IVA), así que ya no es uniformemente sin IVA.
        card.add(filaDesglose("Total efectivo", formatPesos(totalSinIva), true, false));
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
            List<GenerarPresupuestoRequestDTO.FormaPagoSnapshot> formas,
            List<GenerarPresupuestoRequestDTO.Item> items) {
        if (formas == null || formas.isEmpty()) return;

        // Régimen de IVA presente en el presupuesto, para decidir qué badge
        // ("c/IVA"/"s/IVA") mostrar en cada card. Maquinaria usa el perfil
        // maquinaria de la forma; el resto (menaje) el perfil menaje. Si el
        // presupuesto mezcla ambos rubros, una forma cuyo perfil menaje y
        // maquinaria coincidan en aplicaIva muestra ese valor; si difieren, la
        // card no lleva badge (el precioFinal ya es correcto, pero un único
        // "c/IVA"/"s/IVA" sería ambiguo).
        Set<String> rubrosMaq = precioPerfilCalculator.rubrosMaquinariaNormalizados();
        boolean hayMenaje = false;
        boolean hayMaquinaria = false;
        if (items != null) {
            for (GenerarPresupuestoRequestDTO.Item it : items) {
                if (PrecioPerfilCalculator.esMaquinaria(it.rubro(), rubrosMaq)) hayMaquinaria = true;
                else hayMenaje = true;
            }
        }

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
                            i == indiceMejorPrecio,
                            badgeIva(formas.get(i), hayMenaje, hayMaquinaria)));
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
     * Resuelve qué badge de IVA mostrar en la card de una forma de pago, según
     * los regímenes de rubro presentes en el presupuesto:
     * <ul>
     *   <li>Solo menaje → {@code aplicaIva} del perfil menaje.</li>
     *   <li>Solo maquinaria → {@code aplicaIvaMaquinaria} del perfil maquinaria.</li>
     *   <li>Mixto → si ambos perfiles coinciden en aplicaIva, ese valor; si
     *       difieren, {@code null} (la card no lleva badge).</li>
     * </ul>
     * Devuelve {@code true} = "c/IVA", {@code false} = "s/IVA", {@code null} =
     * sin badge. No recalcula precios: el {@code precioFinal} ya viene bien.
     */
    private static Boolean badgeIva(GenerarPresupuestoRequestDTO.FormaPagoSnapshot f,
                                    boolean hayMenaje, boolean hayMaquinaria) {
        if (f == null) return null;
        Boolean menaje = f.aplicaIva();
        Boolean maquinaria = f.aplicaIvaMaquinaria();
        if (hayMaquinaria && !hayMenaje) return maquinaria;
        if (hayMenaje && !hayMaquinaria) return menaje;
        if (!hayMenaje) return menaje; // presupuesto sin ítems → cae al menaje
        // Mixto: solo si ambos perfiles coinciden mostramos un único valor.
        boolean menajeIva = Boolean.TRUE.equals(menaje);
        boolean maquinariaIva = Boolean.TRUE.equals(maquinaria);
        if (menaje != null && maquinaria != null && menajeIva == maquinariaIva) {
            return menajeIva;
        }
        return null;
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
                                   Color borde, boolean esMejorPrecio, Boolean badgeIva) {
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

        // Las cards de formas de pago no muestran badge "c/IVA"/"s/IVA": el
        // régimen depende del producto, no de la forma de pago (el precioFinal
        // ya es correcto). El IVA por producto se ve en la tabla de productos.

        // Limpiamos "s/IVA" si viene dentro de la descripción (presupuestos
        // viejos lo guardaban como parte del string). Ahora se renderiza
        // siempre arriba (c/IVA o s/IVA), así que duplicarlo en la descripción
        // queda redundante.
        String desc = f.descripcion();
        if (desc != null) {
            desc = desc.replaceAll("\\s*·\\s*s/IVA", "")
                    .replaceAll("^s/IVA\\s*·\\s*", "")
                    .replaceAll("^s/IVA$", "")
                    // El "% de descuento" depende del perfil del producto; no se
                    // muestra a nivel forma. Limpiamos el texto de presupuestos
                    // viejos que lo guardaron en la descripción.
                    .replaceAll("\\s*·\\s*\\d+% de descuento", "")
                    .replaceAll("^\\d+% de descuento\\s*·\\s*", "")
                    .replaceAll("^\\d+% de descuento$", "")
                    // "N cuotas" es redundante con el nombre de la forma y con el
                    // detalle "N cuotas de $X" — lo limpiamos de presupuestos viejos.
                    .replaceAll("\\s*·\\s*\\d+ cuotas", "")
                    .replaceAll("^\\d+ cuotas\\s*·\\s*", "")
                    .replaceAll("^\\d+ cuotas$", "")
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

    /** Precio de REFERENCIA unitario (precio con la forma destacada, ya según
     *  rubro: c/IVA menaje, s/IVA maquinaria), SIN descuento individual. Es el
     *  precio de lista que se muestra tachado cuando hay descuento. Fallback para
     *  presupuestos viejos sin `precioReferencia`: precio de lista sin IVA. */
    private static BigDecimal precioListaEfectivo(GenerarPresupuestoRequestDTO.Item item) {
        if (item.precioReferencia() != null) {
            return item.precioReferencia().setScale(2, RoundingMode.HALF_UP);
        }
        BigDecimal precioConIva = item.precioConIva() == null ? BigDecimal.ZERO : item.precioConIva();
        BigDecimal porcIva = item.porcIva() == null ? PrecioPerfilCalculator.IVA_DEFAULT : item.porcIva();
        return PrecioPerfilCalculator.calcularSinIva(precioConIva, porcIva);
    }

    /** Precio EFECTIVO unitario con el descuento individual aplicado. Coincide
     *  con el total de la card "Efectivo" dividido por la cantidad — útil para
     *  que el cliente vea cuánto sale c/u al mejor precio. */
    private static BigDecimal precioUnitarioEfectivo(GenerarPresupuestoRequestDTO.Item item) {
        BigDecimal desc = item.descuentoPorcentaje() == null ? BigDecimal.ZERO : item.descuentoPorcentaje();
        return precioListaEfectivo(item)
                .multiply(BigDecimal.ONE.subtract(desc.movePointLeft(2)))
                .setScale(2, RoundingMode.HALF_UP);
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

    /** Header de dos líneas para una columna de descuento por escalón: el "-X%"
     *  va en una badge con el color del escalón (fondo suave + texto fuerte) y
     *  debajo "desde $Umbral" en gris chico — el umbral aclara a partir de qué
     *  subtotal aplica. */
    private static Cell celdaHeaderDescuento(BigDecimal porcentaje, BigDecimal umbral,
                                             Color fg, Color bg) {
        Cell c = new Cell()
                .setBorder(Border.NO_BORDER)
                .setBorderBottom(new SolidBorder(GRIS_LINEA, 1f))
                .setPadding(6)
                .setTextAlignment(TextAlignment.CENTER);
        c.add(new Paragraph("-" + formatPorcentaje(porcentaje) + "%")
                .simulateBold()
                .setFontSize(8.5f)
                .setCharacterSpacing(0.5f)
                .setFontColor(fg)
                .setBackgroundColor(bg)
                .setBorderRadius(new BorderRadius(8f))
                .setPaddings(2, 6, 2, 6)
                .setTextAlignment(TextAlignment.CENTER)
                .setMargin(0));
        c.add(new Paragraph("desde " + formatPesos(umbral))
                .setFontSize(6)
                .setFontColor(GRIS_MEDIO)
                .setMargin(0)
                .setMarginTop(2));
        return c;
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
        return PdfFormatoUtils.safe(s, fallback);
    }

    private static boolean esTextoValido(String s) {
        return s != null && !s.isBlank();
    }

    private static String formatPesos(BigDecimal v) {
        return PdfFormatoUtils.formatPesos(v);
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
