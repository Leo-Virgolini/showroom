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

    /** Formato de moneda es-AR sin decimales. {@link NumberFormat} NO es
     *  thread-safe y los PDFs se generan en threads {@code @Async} concurrentes
     *  (emails/WhatsApp en paralelo), así que usamos un {@link ThreadLocal}:
     *  una instancia por thread evita que {@code format()} corrompa el monto. */
    private static final ThreadLocal<NumberFormat> PESO_FMT = ThreadLocal.withInitial(() -> {
        NumberFormat nf = NumberFormat.getCurrencyInstance(Locale.of("es", "AR"));
        nf.setMaximumFractionDigits(0);
        nf.setMinimumFractionDigits(0);
        return nf;
    });

    /** Formatea un monto en pesos es-AR sin decimales. null → "$ 0". */
    public static String formatPesos(BigDecimal v) {
        return PESO_FMT.get().format(v == null ? 0 : v.doubleValue());
    }

    /** Devuelve {@code s} si tiene contenido; si es null/blank devuelve el
     *  fallback. Implementación idéntica en los tres generadores de PDF. */
    public static String safe(String s, String fallback) {
        return s == null || s.isBlank() ? fallback : s;
    }
}
