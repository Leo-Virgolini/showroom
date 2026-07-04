package ar.com.leo.showroom.common.pdf;

import com.itextpdf.io.image.ImageData;
import com.itextpdf.kernel.pdf.xobject.PdfImageXObject;
import com.itextpdf.layout.element.Image;

/**
 * Envuelve un {@link ImageData} y crea su {@link PdfImageXObject} UNA sola vez
 * (de forma perezosa), para reusarlo en todas las páginas / celdas donde aparezca
 * la misma imagen (fondo, logo del footer, placeholder SINIMAGEN).
 *
 * <p>Sin esto, cada {@code addImageFittedIntoRectangle(imageData, …)} o
 * {@code new Image(imageData)} hace que iText cree un XObject nuevo y re-incruste
 * la imagen completa. Un logo de ~1&nbsp;MB en el footer de un presupuesto de 20
 * hojas pesaría ~22&nbsp;MB; reusando el XObject se incrusta una única vez.
 *
 * <p>No es thread-safe: cada generación de PDF (un {@code PdfDocument}) usa su
 * propia instancia. El XObject queda ligado al documento donde se dibuja primero.
 */
public final class PdfImagenReutilizable {

    private final ImageData data;
    private PdfImageXObject xObject;

    private PdfImagenReutilizable(ImageData data) {
        this.data = data;
    }

    /** Crea el envoltorio, o {@code null} si {@code data} es {@code null} (recurso ausente). */
    public static PdfImagenReutilizable of(ImageData data) {
        return data == null ? null : new PdfImagenReutilizable(data);
    }

    /** XObject de la imagen, creado en la primera llamada y reusado después. */
    public PdfImageXObject xObject() {
        if (xObject == null) {
            xObject = new PdfImageXObject(data);
        }
        return xObject;
    }

    /** Nueva {@link Image} de layout que referencia el XObject compartido. */
    public Image nuevaImagen() {
        return new Image(xObject());
    }
}
