package ar.com.leo.showroom.config;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.CorsConfigurationSource;
import org.springframework.web.cors.UrlBasedCorsConfigurationSource;

import java.util.Arrays;
import java.util.List;

/**
 * Configuración CORS parametrizable por entorno.
 *
 * <p>Los orígenes permitidos se toman de {@code showroom.cors.allowed-origins}
 * (env var {@code SHOWROOM_CORS_ALLOWED_ORIGINS}, lista separada por comas).
 *
 * <p><b>LAN / dev (default):</b> {@code http://*:*,https://*:*} — la app es
 * un showroom interno accesible indistintamente por IP (192.168.x.x),
 * localhost o hostname NetBIOS/mDNS. Cualquier cliente que acceda por hostname
 * manda el header {@code Origin} y Spring lo valida contra los patterns; con el
 * comodín no recibe 403 en los POST.
 *
 * <p><b>Producción (internet público):</b> el comodín NO es seguro con
 * {@code allowCredentials=true} — cualquier sitio podría hacer requests
 * autenticados. En Coolify/Hetzner hay que setear
 * {@code SHOWROOM_CORS_ALLOWED_ORIGINS=https://showroom.tudominio.com}
 * (uno o varios dominios separados por coma).
 *
 * <p>Se expone como {@link CorsConfigurationSource} (no como
 * {@code WebMvcConfigurer}) para que la config CORS viva en un único lugar: el
 * {@code SecurityConfig} la toma con {@code http.cors(withDefaults())} y el
 * filtro CORS de Spring Security maneja el preflight OPTIONS antes de la
 * autorización. Así no hay dos mecanismos de CORS conviviendo.
 */
@Configuration
public class CorsConfig {

    /**
     * Orígenes permitidos (separados por coma). Se usan como
     * {@code allowedOriginPatterns} para soportar comodines de puerto/host
     * (necesario en LAN) y también dominios exactos (producción).
     */
    @Value("${showroom.cors.allowed-origins:http://*:*,https://*:*}")
    private String allowedOrigins;

    @Bean
    public CorsConfigurationSource corsConfigurationSource() {
        CorsConfiguration config = new CorsConfiguration();
        List<String> patterns = Arrays.stream(allowedOrigins.split(","))
                .map(String::trim)
                .filter(s -> !s.isEmpty())
                .toList();
        config.setAllowedOriginPatterns(patterns);
        // Incluye PATCH — sin esto, el navegador rechaza la preflight OPTIONS
        // para PATCH /carrito/items/{sku} y todo update de cantidad cae con 403.
        config.setAllowedMethods(List.of("GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"));
        config.setAllowedHeaders(List.of("*"));
        // Headers de respuesta custom que el frontend necesita LEER desde JS.
        // Sin esto, en accesos cross-origin (cliente por IP/hostname) el navegador
        // los oculta y `headers.get(...)` devuelve null. `X-Presupuesto-Id`:
        // número del presupuesto recién generado, lo usa el generador para pasar
        // a modo edición.
        config.setExposedHeaders(List.of("X-Presupuesto-Id"));
        config.setAllowCredentials(true);

        UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
        source.registerCorsConfiguration("/api/**", config);
        return source;
    }
}
