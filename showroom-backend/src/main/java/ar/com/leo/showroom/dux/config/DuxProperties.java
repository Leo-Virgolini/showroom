package ar.com.leo.showroom.dux.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "dux")
public record DuxProperties(
        String baseUrl,
        double rateLimitPerSecond,
        int itemsPerPage,
        String listaPreciosNombre,
        Empresa empresa
) {
    public DuxProperties {
        if (baseUrl == null) {
            baseUrl = "https://erp.duxsoftware.com.ar/WSERP/rest/services";
        }
        if (rateLimitPerSecond <= 0) rateLimitPerSecond = 1.0 / 7.0;
        if (itemsPerPage <= 0) itemsPerPage = 50;
        if (listaPreciosNombre == null || listaPreciosNombre.isBlank()) listaPreciosNombre = "KT GASTRO";
        if (empresa == null) empresa = new Empresa(0, null, 0, "CONSUMIDOR_FINAL");
    }

    /**
     * Datos de la empresa DUX usados al crear pedidos.
     * Consultá {@code GET /empresas} y {@code GET /sucursales?idEmpresa=...} para los IDs.
     */
    public record Empresa(
            int id,
            String idSucursal,
            int idDeposito,
            String categoriaFiscalDefault
    ) {
        public Empresa {
            if (categoriaFiscalDefault == null || categoriaFiscalDefault.isBlank()) {
                categoriaFiscalDefault = "CONSUMIDOR_FINAL";
            }
        }
    }
}
