package ar.com.leo.showroom.common.pdf;

import java.math.BigDecimal;
import java.text.NumberFormat;
import java.util.List;
import java.util.Locale;
import java.util.function.Function;

/**
 * Helpers de formato compartidos por los generadores de PDF del showroom
 * (presupuesto comercial, cotización financiera, picking). Centraliza piezas
 * que estaban duplicadas idénticas entre los generadores para que no diverjan.
 *
 * <p>La sanitización estándar de nombres de archivo vive en
 * {@code common.util.NombreArchivoUtils} (la usan picking y el presupuesto
 * comercial); la cotización financiera conserva una variante propia a propósito.
 * {@code formatPesos} tiene un wrapper distinto en picking (null/0 → "-"), por eso
 * acá está solo la versión base.
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

    /**
     * Índice de la forma con menor {@code precioFinal} POSITIVO, ignorando las de
     * moneda extranjera (las que tienen {@code monedaSimbolo} con texto — no se
     * comparan pesos con dólares). Devuelve -1 si la lista tiene ≤1 elemento, si
     * no hay ninguna válida, o si el mínimo empata con otra forma (no se resalta
     * a nadie). Genérico para reusarse con los distintos snapshots de forma de
     * pago (presupuesto comercial y cotización financiera comparten esta lógica).
     */
    public static <T> int indiceMejorPrecio(
            List<T> formas,
            Function<T, BigDecimal> precioFinal,
            Function<T, String> monedaSimbolo) {
        if (formas == null || formas.size() <= 1) return -1;
        int idx = -1;
        BigDecimal min = null;
        for (int i = 0; i < formas.size(); i++) {
            T f = formas.get(i);
            BigDecimal p = precioFinal.apply(f);
            if (p == null || p.signum() <= 0) continue;
            if (esMonedaExtranjera(monedaSimbolo.apply(f))) continue;
            if (min == null || p.compareTo(min) < 0) {
                min = p;
                idx = i;
            }
        }
        if (idx == -1 || min == null) return -1;
        // Si el "mínimo" empata con otra forma, no marcamos a nadie.
        int empates = 0;
        for (T f : formas) {
            BigDecimal p = precioFinal.apply(f);
            if (p != null && !esMonedaExtranjera(monedaSimbolo.apply(f)) && p.compareTo(min) == 0) {
                empates++;
            }
        }
        return empates > 1 ? -1 : idx;
    }

    private static boolean esMonedaExtranjera(String simbolo) {
        return simbolo != null && !simbolo.isBlank();
    }
}
