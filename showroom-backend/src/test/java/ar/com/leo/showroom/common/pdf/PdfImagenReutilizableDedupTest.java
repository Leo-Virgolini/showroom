package ar.com.leo.showroom.common.pdf;

import com.itextpdf.io.image.ImageData;
import com.itextpdf.io.image.ImageDataFactory;
import com.itextpdf.kernel.geom.PageSize;
import com.itextpdf.kernel.pdf.PdfDocument;
import com.itextpdf.kernel.pdf.PdfName;
import com.itextpdf.kernel.pdf.PdfObject;
import com.itextpdf.kernel.pdf.PdfPage;
import com.itextpdf.kernel.pdf.PdfReader;
import com.itextpdf.kernel.pdf.PdfStream;
import com.itextpdf.kernel.pdf.PdfWriter;
import com.itextpdf.kernel.pdf.canvas.PdfCanvas;
import org.junit.jupiter.api.Test;

import javax.imageio.ImageIO;
import java.awt.Color;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * Verifica que {@link PdfImagenReutilizable} incrusta la imagen UNA sola vez aunque se
 * dibuje en muchas páginas — la garantía que hace que el logo del footer (~1MB) no se
 * multiplique por la cantidad de hojas del presupuesto.
 *
 * <p>Con {@code ImageData} crudo + {@code addImageFittedIntoRectangle} por página, iText
 * crearía un XObject nuevo por página (6 imágenes acá). Reusando el XObject → 1.
 */
class PdfImagenReutilizableDedupTest {

    private static final int PAGINAS = 6;

    @Test
    void mismaImagenSeIncrustaUnaSolaVezEnTodasLasPaginas() throws Exception {
        ImageData data = ImageDataFactory.create(pngGris());

        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        try (PdfDocument pdfDoc = new PdfDocument(new PdfWriter(baos))) {
            PdfImagenReutilizable reu = PdfImagenReutilizable.of(data);
            // Simula lo que hacen los BackgroundHandler/FooterHandler: dibujar el
            // MISMO XObject reutilizable en cada página.
            for (int i = 0; i < PAGINAS; i++) {
                PdfPage page = pdfDoc.addNewPage(PageSize.A4);
                PdfCanvas canvas = new PdfCanvas(page);
                canvas.addXObjectFittedIntoRectangle(reu.xObject(), page.getPageSize());
            }
        }

        assertEquals(1, contarImageXObjects(baos.toByteArray()),
                "La imagen reutilizable debe incrustarse una sola vez, no una por página");
    }

    private static int contarImageXObjects(byte[] pdfBytes) throws Exception {
        try (PdfDocument doc = new PdfDocument(new PdfReader(new ByteArrayInputStream(pdfBytes)))) {
            int count = 0;
            int total = doc.getNumberOfPdfObjects();
            for (int i = 1; i < total; i++) {
                PdfObject obj = doc.getPdfObject(i);
                if (obj instanceof PdfStream stream
                        && PdfName.Image.equals(stream.getAsName(PdfName.Subtype))) {
                    count++;
                }
            }
            return count;
        }
    }

    private static byte[] pngGris() throws Exception {
        BufferedImage img = new BufferedImage(48, 48, BufferedImage.TYPE_INT_RGB);
        java.awt.Graphics2D g = img.createGraphics();
        g.setColor(new Color(180, 180, 180));
        g.fillRect(0, 0, 48, 48);
        g.dispose();
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        ImageIO.write(img, "png", baos);
        return baos.toByteArray();
    }
}
