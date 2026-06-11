package ar.com.leo.showroom.common.pdf;

import com.itextpdf.kernel.colors.Color;
import com.itextpdf.kernel.colors.DeviceRgb;

/**
 * Paleta KT GASTRO compartida por los generadores de PDF del showroom. Solo
 * contiene los colores cuyo valor RGB era IDÉNTICO en 2 o más generadores —
 * los que difieren entre archivos (ej. GRIS_CLARO 243,244,246 vs 235,235,235,
 * o el GRIS_LINEA 200,200,200 del PDF de picking) se dejan locales en cada
 * generador para no cambiar la salida.
 */
public final class KtPdfColores {

    private KtPdfColores() {
    }

    /** Naranja KT principal (logo / acentos). Idéntico en los 3 PDFs. */
    public static final Color KT_NARANJA = new DeviceRgb(255, 134, 28);
    /** Marrón KT (header / texto destacado). Idéntico en los 3 PDFs. */
    public static final Color KT_MARRON = new DeviceRgb(59, 30, 9);
    /** Azul del texto del código/SKU. Idéntico en presupuesto y picking. */
    public static final Color KT_AZUL_CODIGO_TEXTO = new DeviceRgb(72, 65, 151);
    /** Verde profundo del precio. Idéntico en presupuesto y picking. */
    public static final Color VERDE_PRECIO = new DeviceRgb(16, 122, 87);
    /** Gris oscuro para texto. Idéntico en los 3 PDFs. */
    public static final Color GRIS_OSCURO = new DeviceRgb(45, 45, 45);
    /** Gris medio para textos secundarios. Idéntico en presupuesto y cotización. */
    public static final Color GRIS_MEDIO = new DeviceRgb(110, 110, 110);
    /** Gris de líneas/bordes suaves. Idéntico en presupuesto y cotización
     *  (el PDF de picking usa otro valor 200,200,200 y lo mantiene local). */
    public static final Color GRIS_LINEA = new DeviceRgb(225, 225, 230);

    /** Colores del borde-top de las cards de formas de pago — sincronizado con
     *  .color-1..10 en el frontend. Array idéntico en presupuesto y cotización.
     *  Si hay más formas que colores, ciclan. */
    public static final Color[] BORDE_FORMA_PAGO = new Color[]{
            new DeviceRgb(234, 179, 8),     // amarillo
            new DeviceRgb(59, 130, 246),    // azul
            new DeviceRgb(239, 68, 68),     // rojo (antes verde esmeralda — chocaba con "mejor precio")
            new DeviceRgb(249, 115, 22),    // naranja
            new DeviceRgb(168, 85, 247),    // púrpura
            new DeviceRgb(236, 72, 153),    // rosa
            new DeviceRgb(6, 182, 212),     // cian
            new DeviceRgb(71, 85, 105),     // pizarra (antes lima — chocaba con "mejor precio")
            new DeviceRgb(99, 102, 241),    // índigo
            new DeviceRgb(217, 119, 6),     // ámbar oscuro
    };
}
