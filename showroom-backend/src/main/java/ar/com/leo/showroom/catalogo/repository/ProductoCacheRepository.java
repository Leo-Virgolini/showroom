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

    /**
     * Busca por SKU, descripción o código de barras (contains).
     * Ordena por relevancia: matches que EMPIEZAN con la query van antes
     * que los que solo CONTIENEN. SKU > descripción dentro de cada grupo.
     * Si la query es vacía/null, todos quedan en el grupo 0 y el orden
     * efectivo es por SKU asc.
     */
    @Query("""
            select distinct p from ProductoCache p
            left join p.codigosBarra c
            where (:q is null or :q = ''
                   or lower(p.sku) like lower(concat('%', :q, '%'))
                   or lower(p.descripcion) like lower(concat('%', :q, '%'))
                   or c like concat('%', :q, '%'))
            order by
              case
                when :q is null or :q = '' then 0
                when lower(p.sku) like lower(concat(:q, '%')) then 0
                when lower(p.descripcion) like lower(concat(:q, '%')) then 1
                else 2
              end,
              p.sku asc
            """)
    Page<ProductoCache> buscar(@Param("q") String q, Pageable pageable);

    /**
     * Variante con filtros usada por la pantalla de listado de productos.
     * `q` matchea contra SKU, descripción o cualquiera de los códigos de barra
     * (contains, case-insensitive).
     * `soloDeshabilitados=true` deja solo `habilitado=false` (NULL no entra).
     * `soloSinStock=true` deja stock null o 0.
     *
     * Orden por relevancia (startsWith antes que contains) seguido del
     * {@link Pageable} sort (que viene de la columna que clickea el operador
     * en la tabla). Si la query está vacía, la relevancia colapsa al grupo 0
     * y solo aplica el sort de la columna.
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
            order by
              case
                when :q is null or :q = '' then 0
                when lower(p.sku) like lower(concat(:q, '%')) then 0
                when lower(p.descripcion) like lower(concat(:q, '%')) then 1
                else 2
              end
            """)
    Page<ProductoCache> buscarConFiltros(
            @Param("q") String q,
            @Param("soloDeshabilitados") boolean soloDeshabilitados,
            @Param("soloSinStock") boolean soloSinStock,
            Pageable pageable
    );
}
