package ar.com.leo.showroom.common.pdf;

import java.math.BigDecimal;
import java.text.NumberFormat;
import java.util.Locale;

/**
 * Helpers de formato compartidos por los generadores de PDF del showroom
 * (presupuesto comercial, cotización financiera, picking). Centraliza piezas
 * que estaban duplicadas idénticas entre los generadores para que no diverjan.
 *
 * <p>OJO: {@code formatPesos} y {@code sanitizar} NO se centralizan acá porque
 * sus implementaciones difieren entre generadores (ver cada uno). Solo viven
 * acá las piezas que eran byte-idénticas: el {@link NumberFormat} de pesos y
 * {@code safe(String, String)}.
 */
public final class PdfFormatoUtils {

    private PdfFormatoUtils() {
    }

    /** Formato de moneda es-AR sin decimales — el mismo init que tenían los
     *  tres generadores de PDF. */
    private static final NumberFormat PESO_FMT =
            NumberFormat.getCurrencyInstance(Locale.of("es", "AR"));

    static {
        PESO_FMT.setMaximumFractionDigits(0);
        PESO_FMT.setMinimumFractionDigits(0);
    }

    /** Formatea un monto en pesos es-AR sin decimales. null → "$ 0". */
    public static String formatPesos(BigDecimal v) {
        if (v == null) return PESO_FMT.format(0);
        return PESO_FMT.format(v.doubleValue());
    }

    /** Devuelve {@code s} si tiene contenido; si es null/blank devuelve el
     *  fallback. Implementación idéntica en los tres generadores de PDF. */
    public static String safe(String s, String fallback) {
        return s == null || s.isBlank() ? fallback : s;
    }
}
