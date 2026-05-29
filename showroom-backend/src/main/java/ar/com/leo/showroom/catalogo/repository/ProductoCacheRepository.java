package ar.com.leo.showroom.catalogo.repository;

import ar.com.leo.showroom.catalogo.entity.ProductoCache;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.JpaSpecificationExecutor;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.Collection;
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

    /** Códigos de barra por producto, en bulk — usado por el listado paginado
     *  para evitar tocar la colección lazy {@code ProductoCache.codigosBarra}
     *  (que requeriría OSIV o sufriría N+1). Una sola query con join sobre la
     *  tabla lateral {@code producto_cache_codigo_barra}. Cada row es
     *  {@code [productoId, ean]}. */
    @Query("select p.id, c from ProductoCache p join p.codigosBarra c where p.id in :ids")
    List<Object[]> findCodigosBarraByProductoIds(@Param("ids") Collection<Long> ids);

    /** Lista de rubros distintos cacheados, ordenada alfabéticamente — popula
     *  el dropdown del filtro de la pantalla /productos. Los nulls/blancos
     *  quedan fuera; el frontend agrega manualmente la opción "todos" / "sin
     *  rubro" si lo necesita. */
    @Query("""
            select distinct p.rubro from ProductoCache p
            where p.rubro is not null and p.rubro <> ''
            order by p.rubro asc
            """)
    List<String> findDistinctRubros();

    // La búsqueda por texto + filtros vive en {@link ProductoCacheSpecs} +
    // {@code findAll(Specification, Pageable)} de JpaSpecificationExecutor.
    // La spec tokeniza el query y matchea cada token contra SKU/desc/EAN, lo
    // que permite que "pan azul" devuelva "PANERA AZUL CHICA" (cosa que un
    // LIKE '%pan azul%' no lograba).
}
