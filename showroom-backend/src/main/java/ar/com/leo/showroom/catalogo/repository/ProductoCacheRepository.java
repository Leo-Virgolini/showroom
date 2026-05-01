package ar.com.leo.showroom.catalogo.repository;

import ar.com.leo.showroom.catalogo.entity.ProductoCache;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

public interface ProductoCacheRepository extends JpaRepository<ProductoCache, Long> {

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

    @Query("select max(p.sincronizadoAt) from ProductoCache p")
    Optional<Instant> findMaxSincronizadoAt();

    @Query("""
            select distinct p from ProductoCache p
            left join p.codigosBarra c
            where (:q is null or :q = ''
                   or lower(p.sku) like lower(concat('%', :q, '%'))
                   or lower(p.descripcion) like lower(concat('%', :q, '%'))
                   or c like concat('%', :q, '%'))
            order by p.sku asc
            """)
    Page<ProductoCache> buscar(@Param("q") String q, Pageable pageable);

    /**
     * Variante con filtros usada por la pantalla de listado de productos.
     * `q` matchea contra SKU, descripción o cualquiera de los códigos de barra.
     * `soloDeshabilitados=true` deja solo `habilitado=false` (NULL no entra).
     * `soloSinStock=true` deja stock null o 0.
     * El orden lo provee el {@link Pageable} (Spring concatena el ORDER BY) — la
     * tabla puede ordenar por cualquier columna whitelisted en el service.
     */
    @Query("""
            select distinct p from ProductoCache p
            left join p.codigosBarra c
            where (:q is null or :q = ''
                   or lower(p.sku) like lower(concat('%', :q, '%'))
                   or lower(p.descripcion) like lower(concat('%', :q, '%'))
                   or c like concat('%', :q, '%'))
              and (:soloDeshabilitados = false or p.habilitado = false)
              and (:soloSinStock = false or p.stockTotal is null or p.stockTotal = 0)
            """)
    Page<ProductoCache> buscarConFiltros(
            @Param("q") String q,
            @Param("soloDeshabilitados") boolean soloDeshabilitados,
            @Param("soloSinStock") boolean soloSinStock,
            Pageable pageable
    );
}
