package ar.com.leo.showroom.common.util;

import java.text.Normalizer;

/**
 * Utilities para construir nombres de archivo a partir de strings de usuario.
 * Quita acentos, reemplaza caracteres no válidos para filesystems y trunca.
 *
 * <p>Vive en {@code common.util} (antes en {@code picking}, package-private) para
 * que los generadores de PDF de distintos paquetes reusen la MISMA sanitización
 * sin copiarla. Nota: {@code CotizacionFinancieraPdfGenerator} usa una variante
 * propia (lowercase, sin sacar acentos ni truncar) — a propósito, no unificada.
 */
public final class NombreArchivoUtils {

    private static final int MAX_LARGO = 40;

    private NombreArchivoUtils() {
    }

    /**
     * Convierte un string libre en algo apto para nombre de archivo:
     *  - Trim
     *  - Saca acentos
     *  - Reemplaza caracteres no [A-Za-z0-9-_] por "-"
     *  - Colapsa "-" repetidos
     *  - Trunca a 40 chars
     *  - Si queda vacío, devuelve "sin-nombre"
     */
    public static String sanitizar(String raw) {
        if (raw == null) return "sin-nombre";
        String s = raw.trim();
        if (s.isEmpty()) return "sin-nombre";

        // Saca acentos: "MARÍA" → "MARIA"
        s = Normalizer.normalize(s, Normalizer.Form.NFD)
                .replaceAll("\\p{InCombiningDiacriticalMarks}+", "");

        // Reemplaza espacios y otros caracteres por "-"
        s = s.replaceAll("[^A-Za-z0-9_-]+", "-");
        s = s.replaceAll("-+", "-");
        s = s.replaceAll("^-|-$", "");

        if (s.isEmpty()) return "sin-nombre";
        if (s.length() > MAX_LARGO) s = s.substring(0, MAX_LARGO);
        return s;
    }
}
