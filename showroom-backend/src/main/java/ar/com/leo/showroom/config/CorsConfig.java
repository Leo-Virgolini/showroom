package ar.com.leo.showroom.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.CorsRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

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
 */
@Configuration
public class CorsConfig {

    @Bean
    public WebMvcConfigurer corsConfigurer() {
        return new WebMvcConfigurer() {
            @Override
            public void addCorsMappings(CorsRegistry registry) {
                registry.addMapping("/api/**")
                        .allowedOriginPatterns("http://*:*", "https://*:*")
                        .allowedMethods("GET", "POST", "PUT", "DELETE", "OPTIONS")
                        .allowedHeaders("*")
                        .allowCredentials(true);
            }
        };
    }
}
