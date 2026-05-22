package ar.com.leo.showroom.dux.config;

import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.client.RestClient;

@Configuration
@EnableConfigurationProperties(DuxProperties.class)
public class DuxConfig {

    /**
     * Cliente HTTP para DUX. Partimos del {@code RestClient.Builder} autoconfigurado
     * por Spring Boot — eso le da auto-detección del {@code ClientHttpRequestFactory}
     * (JDK {@code HttpClient} en este classpath), {@code HttpMessageConverters} con
     * el {@code ObjectMapper} de la app, y los timeouts globales de
     * {@code spring.http.clients.*}.
     */
    @Bean
    public RestClient duxRestClient(RestClient.Builder builder, DuxProperties properties) {
        return builder
                .baseUrl(properties.baseUrl())
                .defaultHeader("accept", "application/json")
                .build();
    }
}
