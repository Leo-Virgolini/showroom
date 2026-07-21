package ar.com.leo.showroom.common.pdf;

import ar.com.leo.showroom.common.Branding;
import com.itextpdf.kernel.geom.PageSize;
import com.itextpdf.kernel.pdf.PdfDocument;
import com.itextpdf.kernel.pdf.PdfWriter;
import com.itextpdf.kernel.pdf.annot.PdfAnnotation;
import com.itextpdf.kernel.pdf.annot.PdfLinkAnnotation;
import com.itextpdf.kernel.pdf.canvas.parser.PdfTextExtractor;
import com.itextpdf.layout.Document;
import com.itextpdf.layout.element.AreaBreak;
import com.itextpdf.layout.element.Paragraph;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Verifica el pie unificado {@link KtPdfFooter}: numeración «Página X de Y» con
 * el total real, el modo «omitir portada» del PDF de picking, y que el link a la
 * tienda quede como anotación clickeable en cada página con pie.
 */
class KtPdfFooterTest {

    @Test
    void numeraTodasLasPaginasConElTotalReal() throws Exception {
        byte[] pdf = generar(3, false);

        try (PdfDocument doc = abrir(pdf)) {
            assertEquals(3, doc.getNumberOfPages());
            for (int i = 1; i <= 3; i++) {
                String texto = PdfTextExtractor.getTextFromPage(doc.getPage(i));
                assertTrue(texto.contains("Página " + i + " de 3"),
                        "La página " + i + " debe decir 'Página " + i + " de 3'. Texto: " + texto);
                assertTrue(texto.contains("kitchentools.com.ar"),
                        "La página " + i + " debe mostrar el link a la tienda");
                assertTrue(tieneLinkTienda(doc.getPage(i).getAnnotations()),
                        "La página " + i + " debe tener el link clickeable a " + Branding.TIENDA_URL);
            }
        }
    }

    @Test
    void omitirPortadaNoNumeraLaPrimeraYRenumeraElResto() throws Exception {
        byte[] pdf = generar(4, true);   // portada + 3 hojas de contenido

        try (PdfDocument doc = abrir(pdf)) {
            // La portada (página 1) no lleva pie.
            String portada = PdfTextExtractor.getTextFromPage(doc.getPage(1));
            assertTrue(!portada.contains("Página") && portada.contains("Portada"),
                    "La portada no debe llevar pie de página. Texto: " + portada);
            assertTrue(doc.getPage(1).getAnnotations().isEmpty(),
                    "La portada no debe tener el link del pie");

            // El resto arranca en "Página 1 de 3".
            for (int i = 2; i <= 4; i++) {
                String texto = PdfTextExtractor.getTextFromPage(doc.getPage(i));
                assertTrue(texto.contains("Página " + (i - 1) + " de 3"),
                        "La página física " + i + " debe decir 'Página " + (i - 1) + " de 3'. Texto: " + texto);
            }
        }
    }

    // ---- helpers ----

    private static byte[] generar(int paginas, boolean omitirPortada) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        try (PdfDocument pdfDoc = new PdfDocument(new PdfWriter(out));
             Document doc = new Document(pdfDoc, PageSize.A4, false)) {
            for (int i = 0; i < paginas; i++) {
                if (i > 0) doc.add(new AreaBreak());
                String etiqueta = (omitirPortada && i == 0) ? "Portada" : "Contenido " + (i + 1);
                doc.add(new Paragraph(etiqueta));
            }
            KtPdfFooter.render(pdfDoc, null, omitirPortada);
            doc.close();
        }
        return out.toByteArray();
    }

    private static PdfDocument abrir(byte[] pdf) throws Exception {
        return new PdfDocument(new com.itextpdf.kernel.pdf.PdfReader(new ByteArrayInputStream(pdf)));
    }

    private static boolean tieneLinkTienda(List<PdfAnnotation> annots) {
        return annots.stream()
                .filter(a -> a instanceof PdfLinkAnnotation)
                .map(a -> ((PdfLinkAnnotation) a).getAction())
                .filter(java.util.Objects::nonNull)
                .anyMatch(action -> {
                    var uri = action.getAsString(com.itextpdf.kernel.pdf.PdfName.URI);
                    return uri != null && Branding.TIENDA_URL.equals(uri.getValue());
                });
    }
}
