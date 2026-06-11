package ar.com.leo.showroom.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.CorsConfigurationSource;
import org.springframework.web.cors.UrlBasedCorsConfigurationSource;

import java.util.List;

/**
 * Configuracion CORS abierta a cualquier host por HTTP. La app es LAN-only
 * (showroom interno), no esta expuesta a internet, y los clientes acceden
 * indistintamente por IP (192.168.x.x), localhost en la PC servidor, o por
 * hostname NetBIOS/mDNS (ej. http://servidor:8080).
 *
 * <p>Antes la lista era restrictiva (localhost, 192.168.*, 10.*). Cualquier
 * cliente que accediera por hostname recibia 403 en POSTs porque Chrome
 * manda el header {@code Origin} y Spring lo valida contra los patterns —
 * GETs same-origin pasaban porque no incluyen {@code Origin}.
 *
 * <p>Se expone como {@link CorsConfigurationSource} (no como
 * {@code WebMvcConfigurer}) para que la config CORS viva en un único lugar: el
 * {@code SecurityConfig} la toma con {@code http.cors(withDefaults())} y el
 * filtro CORS de Spring Security maneja el preflight OPTIONS antes de la
 * autorización. Así no hay dos mecanismos de CORS conviviendo.
 */
@Configuration
public class CorsConfig {

    @Bean
    public CorsConfigurationSource corsConfigurationSource() {
        CorsConfiguration config = new CorsConfiguration();
        config.setAllowedOriginPatterns(List.of("http://*:*", "https://*:*"));
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
