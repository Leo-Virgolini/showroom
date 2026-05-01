package ar.com.leo.showroom.dux.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

import java.time.Duration;

@ConfigurationProperties(prefix = "dux")
public record DuxProperties(
        String baseUrl,
        Duration connectTimeout,
        Duration readTimeout,
        double rateLimitPerSecond,
        int itemsPerPage,
        String listaPreciosNombre,
        Empresa empresa
) {
    public DuxProperties {
        if (baseUrl == null) {
            baseUrl = "https://erp.duxsoftware.com.ar/WSERP/rest/services";
        }
        if (connectTimeout == null) connectTimeout = Duration.ofSeconds(10);
        if (readTimeout == null) readTimeout = Duration.ofSeconds(30);
        if (rateLimitPerSecond <= 0) rateLimitPerSecond = 1.0 / 7.0;
        if (itemsPerPage <= 0) itemsPerPage = 50;
        if (listaPreciosNombre == null || listaPreciosNombre.isBlank()) listaPreciosNombre = "KT GASTRO";
        if (empresa == null) empresa = new Empresa(0, null, 0, "CONSUMIDOR_FINAL", null);
    }

    /**
     * Datos de la empresa DUX usados al crear pedidos.
     * Consultá {@code GET /empresas} y {@code GET /sucursales?idEmpresa=...} para los IDs.
     */
    public record Empresa(
            int id,
            String idSucursal,
            int idDeposito,
            String categoriaFiscalDefault,
            /** Id del vendedor en DUX (opcional). Si está seteado, se envía en el pedido
             *  bajo varias keys candidatas. Consultá `GET /personal?idEmpresa=...` para
             *  obtener los IDs disponibles. */
            Integer idVendedor
    ) {
        public Empresa {
            if (categoriaFiscalDefault == null || categoriaFiscalDefault.isBlank()) {
                categoriaFiscalDefault = "CONSUMIDOR_FINAL";
            }
        }
    }
}
