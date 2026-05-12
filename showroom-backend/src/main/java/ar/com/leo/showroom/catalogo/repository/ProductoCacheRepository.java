package ar.com.leo.showroom.catalogo.repository;

import ar.com.leo.showroom.catalogo.entity.ProductoCache;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.JpaSpecificationExecutor;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.Optional;

public interface ProductoCacheRepository extends JpaRepository<ProductoCache, Long>,
        JpaSpecificationExecutor<ProductoCache> {

    Optional<ProductoCache> findBySku(String sku);

    List<ProductoCache> findBySkuIn(List<String> skus);

    /**
     * Busca productos que tengan exactamente este EAN entre sus códigos de barra.
     * Resuelto con JOIN sobre la tabla lateral {@code producto_cache_codigo_barra},
     * que tiene índice sobre `ean` — lookup O(log N). Uso típico: pistola escanea
     * EAN-13 y resolvemos el SKU. Devuelve lista (en práctica 0 o 1 elementos —
     * si hay duplicado, el caller toma el primero por SKU).
     */
    @Query("""
            select p from ProductoCache p
            join p.codigosBarra c
            where c = :ean
            order by p.sku asc
            """)
    List<ProductoCache> findByCodigoBarra(@Param("ean") String ean);

    // La búsqueda por texto + filtros vive en {@link ProductoCacheSpecs} +
    // {@code findAll(Specification, Pageable)} de JpaSpecificationExecutor.
    // La spec tokeniza el query y matchea cada token contra SKU/desc/EAN, lo
    // que permite que "pan azul" devuelva "PANERA AZUL CHICA" (cosa que un
    // LIKE '%pan azul%' no lograba).
}
