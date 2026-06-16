package ar.com.leo.showroom.common.util;

import org.springframework.data.domain.Sort;

import java.util.Map;

/**
 * Helper para resolver el {@link Sort} de los listados paginados a partir de los
 * params que manda el front. Centraliza el patrón repetido en los services:
 * whitelist de campos permitidos + dirección "asc"/desc + default.
 */
public final class SortUtils {

    private SortUtils() {
    }

    /**
     * Resuelve un {@link Sort} a partir de params del front: busca
     * {@code sortField} en la whitelist (campo-front → propiedad-entidad); si no
     * está —o si {@code sortField} es null porque el front no mandó el param—,
     * usa {@code defaultField}. Dirección: {@code "asc"} → ASC, cualquier otro
     * valor → DESC.
     *
     * <p>El guard contra null es obligatorio: la whitelist es un {@code Map.of(...)}
     * inmutable, y {@code getOrDefault(null, ...)} sobre esos mapas lanza
     * {@link NullPointerException} (no admiten claves null).
     */
    public static Sort resolver(Map<String, String> whitelist, String sortField,
                                String sortOrder, String defaultField) {
        String campo = sortField == null
                ? defaultField
                : whitelist.getOrDefault(sortField, defaultField);
        Sort.Direction dir = "asc".equalsIgnoreCase(sortOrder)
                ? Sort.Direction.ASC : Sort.Direction.DESC;
        return Sort.by(dir, campo);
    }
}
