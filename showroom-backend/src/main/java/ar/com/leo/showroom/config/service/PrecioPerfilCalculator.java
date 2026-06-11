package ar.com.leo.showroom.config.service;

import ar.com.leo.showroom.config.entity.FormaPago;
import org.springframework.stereotype.Component;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.text.Normalizer;
import java.util.HashSet;
import java.util.Set;

/**
 * Cálculo de precios según el "perfil por rubro" (menaje / maquinaria) de una
 * forma de pago. Fuente única de la fórmula, compartida por el showroom
 * (scan/visor/carrito/pedidos) y el presupuestador, para que no diverjan.
 *
 * <p>Cada {@link FormaPago} tiene dos perfiles: el perfil menaje
 * ({@code recargoPorcentaje} + {@code aplicaIva}) y el perfil maquinaria
 * ({@code recargoPorcentajeMaquinaria} + {@code aplicaIvaMaquinaria}, nullable).
 * El rubro del producto decide cuál se usa: los rubros de la lista configurable
 * {@code precios.rubros-sin-iva} (ver {@link ConfiguracionService}) usan el
 * perfil maquinaria. El perfil maquinaria es independiente del menaje: recargo
 * null → 0 (no hereda), aplicaIva null → false.
 */
@Component
public class PrecioPerfilCalculator {

    private static final BigDecimal CIEN = new BigDecimal("100");

    /** IVA general de Argentina (21%). Fallback que se usa cuando un ítem no
     *  trae {@code porcIva} cargado — fuente única para todos los generadores
     *  de PDF y servicios del showroom. */
    public static final BigDecimal IVA_DEFAULT = BigDecimal.valueOf(21);

    private final ConfiguracionService configuracionService;

    public PrecioPerfilCalculator(ConfiguracionService configuracionService) {
        this.configuracionService = configuracionService;
    }

    /** Normaliza un rubro para comparación robusta (trim, sin acentos, mayúsculas). */
    public static String normalizarRubro(String rubro) {
        if (rubro == null) return "";
        return Normalizer.normalize(rubro.trim(), Normalizer.Form.NFD)
                .replaceAll("\\p{M}", "").toUpperCase();
    }

    /** Set normalizado de rubros de maquinaria (configurables; misma lista que
     *  "rubros que cotizan sin IVA"). */
    public Set<String> rubrosMaquinariaNormalizados() {
        Set<String> set = new HashSet<>();
        for (String r : configuracionService.getRubrosSinIva()) {
            String n = normalizarRubro(r);
            if (!n.isEmpty()) set.add(n);
        }
        return set;
    }

    /** True si el rubro es de maquinaria (usa la lista configurable). */
    public boolean esMaquinaria(String rubro) {
        return esMaquinaria(rubro, rubrosMaquinariaNormalizados());
    }

    /** Variante que recibe el set ya calculado (para loops que lo reusan). */
    public static boolean esMaquinaria(String rubro, Set<String> rubrosMaquinariaNormalizados) {
        return !rubrosMaquinariaNormalizados.isEmpty()
                && rubrosMaquinariaNormalizados.contains(normalizarRubro(rubro));
    }

    /** Recargo del perfil del rubro. Maquinaria: su propio recargo (null → 0, NO
     *  hereda del menaje). Menaje: recargoPorcentaje (null → 0). */
    public static BigDecimal recargoPerfil(FormaPago fp, boolean esMaquinaria) {
        if (fp == null) return BigDecimal.ZERO;
        if (esMaquinaria) {
            return fp.getRecargoPorcentajeMaquinaria() != null
                    ? fp.getRecargoPorcentajeMaquinaria() : BigDecimal.ZERO;
        }
        return fp.getRecargoPorcentaje() != null ? fp.getRecargoPorcentaje() : BigDecimal.ZERO;
    }

    /** aplicaIva del perfil: maquinaria null→false; menaje null→true. */
    public static boolean aplicaIvaPerfil(FormaPago fp, boolean esMaquinaria) {
        if (fp == null) return true;
        if (esMaquinaria) return Boolean.TRUE.equals(fp.getAplicaIvaMaquinaria());
        return !Boolean.FALSE.equals(fp.getAplicaIva());
    }

    /** Precio sin IVA = conIva / (1 + iva/100). */
    public static BigDecimal calcularSinIva(BigDecimal conIva, BigDecimal porcIva) {
        if (conIva == null) return null;
        if (porcIva == null || porcIva.signum() == 0) return conIva.setScale(2, RoundingMode.HALF_UP);
        BigDecimal divisor = BigDecimal.ONE.add(porcIva.divide(CIEN, 6, RoundingMode.HALF_UP));
        return conIva.divide(divisor, 2, RoundingMode.HALF_UP);
    }

    /**
     * Aplica el recargo/descuento de la forma sobre el precio sin IVA.
     * Recargo &gt; 0 = financiación (divide por 1-r/100, encarece). Recargo &lt; 0 =
     * descuento (multiplica por 1+r/100 = 1-|r|/100, ej. Efectivo -13%), coincidiendo
     * con el precio mostrado en scan/visor/carrito. Recargo 0 = sin cambio.
     */
    public static BigDecimal aplicarRecargoSinIva(BigDecimal precioBaseSinIva, BigDecimal recargoPorc) {
        if (recargoPorc.signum() > 0) {
            return precioBaseSinIva.divide(
                    BigDecimal.ONE.subtract(recargoPorc.divide(CIEN, 6, RoundingMode.HALF_UP)),
                    6, RoundingMode.HALF_UP);
        }
        if (recargoPorc.signum() < 0) {
            return precioBaseSinIva.multiply(
                    BigDecimal.ONE.add(recargoPorc.divide(CIEN, 6, RoundingMode.HALF_UP)));
        }
        return precioBaseSinIva;
    }

    /**
     * Precio final unitario que paga el cliente: parte del precio base con IVA,
     * le quita el IVA, aplica el recargo del perfil, y vuelve a sumar IVA solo si
     * el perfil {@code aplicaIva}.
     */
    public static BigDecimal calcularPrecioFinal(BigDecimal precioBaseConIva, BigDecimal porcIva,
                                                 BigDecimal recargoPorc, boolean aplicaIva) {
        if (precioBaseConIva == null) return null;
        BigDecimal precioBaseSinIva = calcularSinIva(precioBaseConIva, porcIva);
        if (precioBaseSinIva == null) return precioBaseConIva;

        BigDecimal precioRecargadoSinIva = aplicarRecargoSinIva(
                precioBaseSinIva, recargoPorc != null ? recargoPorc : BigDecimal.ZERO);

        if (aplicaIva && porcIva != null && porcIva.signum() > 0) {
            BigDecimal ivaFactor = BigDecimal.ONE.add(porcIva.divide(CIEN, 6, RoundingMode.HALF_UP));
            return precioRecargadoSinIva.multiply(ivaFactor).setScale(4, RoundingMode.HALF_UP);
        }
        return precioRecargadoSinIva.setScale(4, RoundingMode.HALF_UP);
    }

    /**
     * Precio CON IVA que va al comprobante DUX. Independiente del flag
     * {@code aplicaIva} de la forma — DUX siempre factura con IVA, sea cual sea
     * lo que pagó el cliente (para "sin IVA" la diferencia la absorbe el operador).
     */
    public static BigDecimal calcularPrecioParaDux(BigDecimal precioBaseConIva, BigDecimal porcIva,
                                                   BigDecimal recargoPorc) {
        return calcularPrecioFinal(precioBaseConIva, porcIva, recargoPorc, true);
    }

}
