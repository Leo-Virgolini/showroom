package ar.com.leo.showroom.common.pdf;

import ar.com.leo.showroom.common.Branding;
import com.itextpdf.kernel.geom.Rectangle;
import com.itextpdf.kernel.pdf.PdfArray;
import com.itextpdf.kernel.pdf.PdfDocument;
import com.itextpdf.kernel.pdf.PdfPage;
import com.itextpdf.kernel.pdf.action.PdfAction;
import com.itextpdf.kernel.pdf.annot.PdfLinkAnnotation;
import com.itextpdf.kernel.pdf.canvas.PdfCanvas;
import com.itextpdf.layout.Canvas;
import com.itextpdf.layout.element.Paragraph;
import com.itextpdf.layout.properties.TextAlignment;

/**
 * Pie de página unificado de los PDFs del showroom (presupuesto comercial,
 * cotización financiera y picking). Reemplaza los tres {@code FooterHandler}
 * casi-duplicados que había en cada generador para que no diverjan.
 *
 * <p>Layout (margen inferior de la A4):
 * <ul>
 *   <li>Línea separadora fina de margen a margen.</li>
 *   <li>Izquierda: ícono K compacto + link clickeable a la tienda
 *       ({@link Branding#TIENDA_URL}).</li>
 *   <li>Derecha: «Página X de Y».</li>
 * </ul>
 *
 * <p><b>Por qué post-render y no un event handler:</b> «de Y» necesita el total
 * real de páginas, que dentro del handler {@code END_PAGE} no está disponible en
 * las hojas intermedias. Este método se llama UNA vez, después de agregar todo el
 * contenido y antes de cerrar el documento, cuando {@link PdfDocument#getNumberOfPages()}
 * ya es el total definitivo. Requiere que el {@code Document} se haya creado con
 * {@code immediateFlush=false} para poder escribir sobre páginas ya renderizadas.
 */
public final class KtPdfFooter {

    private KtPdfFooter() {
    }

    private static final String TIENDA_URL = Branding.TIENDA_URL;
    private static final String TIENDA_LABEL = Branding.TIENDA_LABEL;

    private static final float MARGEN_X = 30f;      // margen lateral (los 3 generadores usan 30)
    private static final float LINEA_Y = 34f;       // y de la línea separadora
    private static final float EJE_Y = 16f;         // centro vertical del contenido del pie
    private static final float LOGO_W = 30f;        // el logo real es 700×572 (ratio ~1.22);
    private static final float LOGO_H = 25f;        // 30×25 respeta esa proporción sin deformar
    private static final float GAP = 6f;            // separación logo → texto
    private static final float FONT_SIZE = 9f;

    /**
     * Dibuja el pie en todas las páginas ya creadas del documento.
     *
     * @param pdfDoc               documento (con contenido ya agregado, sin cerrar)
     * @param logo                 ícono K reutilizable; si es {@code null} se omite
     * @param omitirPrimeraPagina  si {@code true}, la portada (página 1) queda sin
     *                             pie y la numeración arranca en 1 en la página 2
     *                             (patrón del PDF de picking)
     */
    public static void render(PdfDocument pdfDoc, PdfImagenReutilizable logo, boolean omitirPrimeraPagina) {
        int totalPaginas = pdfDoc.getNumberOfPages();
        int totalMostrado = omitirPrimeraPagina ? totalPaginas - 1 : totalPaginas;
        for (int i = 1; i <= totalPaginas; i++) {
            if (omitirPrimeraPagina && i == 1) continue;
            int numeroMostrado = omitirPrimeraPagina ? i - 1 : i;
            try {
                renderPagina(pdfDoc, pdfDoc.getPage(i), logo, numeroMostrado, totalMostrado);
            } catch (Exception ignored) {
                // El pie es decorativo: si falla en una hoja, el resto del PDF sigue válido.
            }
        }
    }

    private static void renderPagina(PdfDocument pdfDoc, PdfPage page, PdfImagenReutilizable logo,
                                     int numero, int total) {
        float ancho = page.getPageSize().getWidth();
        float derechaX = ancho - MARGEN_X;

        PdfCanvas pdfCanvas = new PdfCanvas(page.newContentStreamAfter(), page.getResources(), pdfDoc);

        // Línea separadora fina de margen a margen.
        pdfCanvas.saveState()
                .setStrokeColor(KtPdfColores.GRIS_LINEA)
                .setLineWidth(0.5f)
                .moveTo(MARGEN_X, LINEA_Y)
                .lineTo(derechaX, LINEA_Y)
                .stroke()
                .restoreState();

        float textoBaseY = EJE_Y - 4f;

        // Izquierda: logo KT (centrado verticalmente en el eje del pie) + link.
        float textoX = MARGEN_X;
        if (logo != null) {
            Rectangle logoRect = new Rectangle(MARGEN_X, EJE_Y - LOGO_H / 2f, LOGO_W, LOGO_H);
            pdfCanvas.addXObjectFittedIntoRectangle(logo.xObject(), logoRect);
            textoX = MARGEN_X + LOGO_W + GAP;
        }
        float anchoTiendaHotspot = 110f;
        Rectangle areaTienda = new Rectangle(textoX, textoBaseY, anchoTiendaHotspot, 14f);
        try (Canvas canvas = new Canvas(pdfCanvas, areaTienda)) {
            canvas.add(new Paragraph(TIENDA_LABEL)
                    .setFontSize(FONT_SIZE)
                    .setFontColor(KtPdfColores.KT_NARANJA)
                    .setUnderline()
                    .setMargin(0));
        }
        // Anotación de link clickeable sobre el texto de la tienda. Se agrega
        // aparte del Canvas de texto porque el PdfCanvas de un stream suelto no
        // registra la anotación en la página por sí solo.
        PdfLinkAnnotation link = new PdfLinkAnnotation(
                new Rectangle(textoX, textoBaseY - 1f, anchoTiendaHotspot, 15f));
        link.setAction(PdfAction.createURI(TIENDA_URL));
        link.setBorder(new PdfArray(new float[]{0, 0, 0}));   // sin borde visible
        page.addAnnotation(link);

        // Derecha: "Página X de Y".
        float anchoTexto = 160f;
        Rectangle areaPagina = new Rectangle(derechaX - anchoTexto, textoBaseY, anchoTexto, 14f);
        try (Canvas canvas = new Canvas(pdfCanvas, areaPagina)) {
            canvas.add(new Paragraph("Página " + numero + " de " + total)
                    .setFontSize(FONT_SIZE)
                    .setFontColor(KtPdfColores.GRIS_MEDIO)
                    .setTextAlignment(TextAlignment.RIGHT)
                    .setMargin(0));
        }
    }
}
