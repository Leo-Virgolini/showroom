package ar.com.leo.showroom.common.util;

/**
 * Helpers menores de manejo de texto. Nombre {@code TextUtils} (no
 * {@code StringUtils}) a propósito: varios services ya importan
 * {@code org.springframework.util.StringUtils} y un nombre homónimo forzaría
 * FQN o colisión de imports.
 */
public final class TextUtils {

    private TextUtils() {
    }

    /** Normaliza un string a {@code null} si es {@code null} o blank; de lo
     *  contrario devuelve el valor trimmeado. */
    public static String blankToNull(String s) {
        return s == null || s.isBlank() ? null : s.trim();
    }
}
