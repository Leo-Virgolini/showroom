package ar.com.leo.showroom.common.pdf;

import com.itextpdf.io.image.ImageData;
import com.itextpdf.io.image.ImageDataFactory;
import com.itextpdf.layout.element.Image;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.net.URL;

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

/**
 * Helpers compartidos para preparar imágenes de productos antes de embeberlas
 * en PDFs. Recetas portadas del {@code java-pdf-catalog-generator}:
 * <ol>
 *   <li>Recorta los bordes blancos (R/G/B &gt;= 240) con 50px de margen
 *       vertical extra — aprovecha mejor la celda cuando la foto tiene
 *       mucho fondo blanco.</li>
 *   <li>Redimensiona con interpolación bicúbica a
 *       {@code displaySizePt × TARGET_DPI / 72} — embebir 3000×3000 px para
 *       mostrar a 140 pt es 16× más bytes de lo que el PDF puede renderizar.
 *       Acá se gana la mayor parte del tamaño.</li>
 *   <li>Encodea como JPEG con calidad 0.78 y Huffman tables optimizadas —
 *       imperceptible para fotos de producto con fondo blanco.</li>
 * </ol>
 */
public final class PdfImagenUtils {

    private static final Logger log = LoggerFactory.getLogger(PdfImagenUtils.class);

    /** DPI objetivo para las imágenes de productos embebidas. 200 DPI alcanza
     *  para visualización en pantalla/mobile sin pixelado al hacer zoom medio.
     *  Más alto serviría para impresión pero infla el PDF (que va por email). */
    private static final float TARGET_DPI = 200f;

    /** Calidad JPEG. 0.78 es imperceptible para fotos de producto típicas
     *  (fondo blanco, pocos detalles finos) y reduce ~25% extra de bytes vs 0.85. */
    private static final float JPEG_QUALITY = 0.78f;

    private PdfImagenUtils() {}

    /**
     * Carga una imagen ESTÁTICA del classpath (logos, fondos, placeholders en
     * {@code /images/...}) como {@link ImageData} de iText. Devuelve {@code null}
     * — sin lanzar — si el recurso no existe o no se puede decodificar, para que
     * la generación del PDF siga sin la decoración. Unifica las tres variantes que
     * tenían los generadores (una de ellas sin null-check → NPE si faltaba el
     * recurso). Para imágenes de PRODUCTO desde disco usar
     * {@link #cargarImagenProducto}.
     */
    public static ImageData cargarImagenClasspath(String resourcePath) {
        URL url = PdfImagenUtils.class.getResource(resourcePath);
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

    /**
     * Carga una imagen de producto desde disco y la prepara para embeber en el
     * PDF (recorte + resize + recompresión JPEG).
     *
     * <p>Si {@code archivo} es {@code null} o no existe, devuelve un Image con
     * el {@code fallback} o {@code null} si tampoco hay fallback. Si
     * {@code ImageIO} no puede leer el formato (ej. webp animado), carga el
     * archivo tal cual sin recortar — iText soporta más formatos que ImageIO.
     * Si la imagen es completamente blanca o falla el procesado, cae al
     * fallback.
     *
     * @param archivo       archivo de la imagen original, puede ser {@code null}.
     * @param fallback      placeholder reutilizable a usar si no hay archivo o el
     *                      procesado falla. Puede ser {@code null}. Se dibuja
     *                      reusando un único XObject (se incrusta una sola vez).
     * @param displaySizePt tamaño máximo de visualización en puntos PDF
     *                      (define el target en px vía {@link #TARGET_DPI}).
     */
    public static Image cargarImagenProducto(File archivo, PdfImagenReutilizable fallback, float displaySizePt) {
        if (archivo == null || !archivo.exists()) {
            return fallback != null ? fallback.nuevaImagen() : null;
        }
        try {
            BufferedImage original = ImageIO.read(archivo);
            if (original == null) {
                // ImageIO no soporta el formato — lo cargamos tal cual via iText.
                return new Image(ImageDataFactory.create(archivo.toString()));
            }
            BufferedImage recortada = recortarBordesBlancos(original);
            if (recortada == null) {
                log.warn("Imagen sin contenido visible (toda blanca): {}", archivo.getName());
                return fallback != null ? fallback.nuevaImagen() : null;
            }
            int targetPx = Math.max(1, Math.round(displaySizePt * TARGET_DPI / 72f));
            BufferedImage preparada = redimensionarParaJpeg(recortada, targetPx);
            byte[] jpeg = encodeJpeg(preparada, JPEG_QUALITY);
            return new Image(ImageDataFactory.create(jpeg));
        } catch (Exception e) {
            log.warn("Error procesando imagen {}: {}", archivo.getName(), e.getMessage());
            return fallback != null ? fallback.nuevaImagen() : null;
        }
    }

    /**
     * Reduce la imagen a {@code maxDim} píxeles en su dimensión más larga
     * (manteniendo aspect ratio) y la aplana contra fondo blanco para que sea
     * válida como JPEG. Usa interpolación bicúbica + antialiasing para mantener
     * nitidez en el downscale.
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
}
