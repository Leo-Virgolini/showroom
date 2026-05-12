package ar.com.leo.showroom.catalogo.repository;

import ar.com.leo.showroom.catalogo.entity.ProductoCache;
import jakarta.persistence.criteria.Expression;
import jakarta.persistence.criteria.Join;
import jakarta.persistence.criteria.JoinType;
import jakarta.persistence.criteria.Order;
import jakarta.persistence.criteria.Predicate;
import org.springframework.data.jpa.domain.Specification;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.regex.Pattern;

/**
 * Specifications de búsqueda sobre {@link ProductoCache}. Tokenizan el query
 * por whitespace y matchean cada token (AND) contra SKU / descripción / EAN.
 *
 * <p>Ejemplo: query <code>"pan azul"</code> → tokens <code>["pan", "azul"]</code> →
 * matchea "PANERA AZUL CHICA" (sku/desc contiene "pan" Y "azul"). El LIKE
 * tradicional <code>%pan azul%</code> habría fallado porque entre "pan" y
 * "azul" hay otras letras ("PAN-era AZUL").
 *
 * <p><b>Ranking:</b> cuando hay tokens, ordena por relevancia del primer
 * token (típicamente el más específico que el operador tipea primero):
 * <ol start="0">
 *   <li>SKU empieza con el primer token</li>
 *   <li>Descripción empieza con el primer token (incluye "PANERA..." cuando se
 *       busca "pan")</li>
 *   <li>El primer token aparece solo como sub-string interna</li>
 * </ol>
 * Empate se rompe por SKU asc.
 */
public final class ProductoCacheSpecs {

    private static final Pattern TOKEN_SPLIT = Pattern.compile("\\s+");

    private ProductoCacheSpecs() {}

    /** Tokeniza el query: split por whitespace, descarta vacíos, lowercase. */
    public static List<String> tokenizar(String q) {
        if (q == null) return List.of();
        String trimmed = q.trim();
        if (trimmed.isEmpty()) return List.of();
        return Arrays.stream(TOKEN_SPLIT.split(trimmed.toLowerCase()))
                .filter(s -> !s.isEmpty())
                .toList();
    }

    /**
     * AND de tokens sobre SKU / descripción / EAN + ranking por relevancia del
     * primer token. Si se va a respetar un sort del operador (clickeable en
     * tabla), pasar {@code aplicarRanking=false} para que el Pageable mande.
     */
    public static Specification<ProductoCache> matchTokens(List<String> tokens, boolean aplicarRanking) {
        return (root, query, cb) -> {
            // DISTINCT por el LEFT JOIN con codigosBarra (sino el producto se
            // repite N veces si tiene N EAN).
            if (query != null) query.distinct(true);

            if (tokens == null || tokens.isEmpty()) {
                // Sin query → sin filtro, sin ranking. El sort lo decide el caller.
                return cb.conjunction();
            }

            Join<ProductoCache, String> codigos = root.join("codigosBarra", JoinType.LEFT);

            List<Predicate> ands = new ArrayList<>(tokens.size());
            for (String t : tokens) {
                String like = "%" + t + "%";
                Predicate skuMatch = cb.like(cb.lower(root.get("sku")), like);
                Predicate descMatch = cb.like(cb.lower(root.get("descripcion")), like);
                Predicate eanMatch = cb.like(codigos, like);
                ands.add(cb.or(skuMatch, descMatch, eanMatch));
            }

            if (aplicarRanking && query != null) {
                String first = tokens.get(0);
                String prefix = first + "%";
                Expression<Object> score = cb.selectCase()
                        .when(cb.like(cb.lower(root.get("sku")), prefix), 0)
                        .when(cb.like(cb.lower(root.get("descripcion")), prefix), 1)
                        .otherwise(2);
                List<Order> orders = new ArrayList<>();
                orders.add(cb.asc(score));
                orders.add(cb.asc(root.get("sku")));
                query.orderBy(orders);
            }

            return cb.and(ands.toArray(new Predicate[0]));
        };
    }

    /** {@code habilitado = false} (NULL no entra). */
    public static Specification<ProductoCache> soloDeshabilitados() {
        return (root, query, cb) -> cb.equal(root.get("habilitado"), false);
    }

    /** {@code stockTotal IS NULL OR stockTotal <= 0}. */
    public static Specification<ProductoCache> soloSinStock() {
        return (root, query, cb) -> cb.or(
                cb.isNull(root.get("stockTotal")),
                cb.lessThanOrEqualTo(root.get("stockTotal"), 0)
        );
    }
}
