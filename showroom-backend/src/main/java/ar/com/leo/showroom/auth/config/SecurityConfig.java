package ar.com.leo.showroom.auth.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.security.authentication.AuthenticationManager;
import org.springframework.security.config.annotation.authentication.configuration.AuthenticationConfiguration;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.logout.HttpStatusReturningLogoutSuccessHandler;
import org.springframework.security.web.csrf.CookieCsrfTokenRepository;
import org.springframework.security.web.csrf.CsrfTokenRequestAttributeHandler;

/**
 * Spring Security:
 *  <ul>
 *    <li>Sesiones via cookie {@code JSESSIONID} (HttpOnly), persistidas con
 *        timeout configurado en {@code application.properties}.</li>
 *    <li>Login via {@code POST /api/auth/login} (manejado por {@code AuthController}).</li>
 *    <li>Logout via {@code POST /api/auth/logout} (manejado por Spring Security).</li>
 *    <li>CSRF activo con cookie {@code XSRF-TOKEN} (header {@code X-XSRF-TOKEN}).
 *        Angular lo manda automáticamente con {@code provideHttpClient(withXsrfConfiguration)}.</li>
 *    <li>Endpoints públicos: {@code /api/auth/**}, {@code /api/showroom/events} (SSE del visor),
 *        imágenes de productos, {@code GET /api/showroom/config/escalas-descuento}, scan.
 *        El resto requiere autenticación.</li>
 *  </ul>
 */
@Configuration
public class SecurityConfig {

    @Bean
    public PasswordEncoder passwordEncoder() {
        return new BCryptPasswordEncoder();
    }

    @Bean
    public AuthenticationManager authenticationManager(AuthenticationConfiguration config) throws Exception {
        return config.getAuthenticationManager();
    }

    @Bean
    public SecurityFilterChain securityFilterChain(HttpSecurity http) throws Exception {
        // CSRF con cookie XSRF-TOKEN. Angular HttpClientXsrfModule lo agrega
        // como header X-XSRF-TOKEN automáticamente para requests "mutantes"
        // (POST/PUT/DELETE/PATCH).
        CookieCsrfTokenRepository csrfRepo = CookieCsrfTokenRepository.withHttpOnlyFalse();
        CsrfTokenRequestAttributeHandler csrfHandler = new CsrfTokenRequestAttributeHandler();
        // Resolver el header eager (sino Spring no lo lee del request body).
        csrfHandler.setCsrfRequestAttributeName(null);

        http
                .csrf(csrf -> csrf
                        .csrfTokenRepository(csrfRepo)
                        .csrfTokenRequestHandler(csrfHandler)
                        // El login no tiene sesión todavía → exento.
                        .ignoringRequestMatchers("/api/auth/login"))
                .cors(AbstractHttpConfigurer::disable)
                .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.IF_REQUIRED))
                .authorizeHttpRequests(auth -> auth
                        // Auth endpoints (login y me siempre disponibles; el chequeo de
                        // sesión activa lo hace el propio AuthController).
                        .requestMatchers("/api/auth/login", "/api/auth/me").permitAll()
                        // SSE + recursos que necesita el visor (lectura pública).
                        .requestMatchers("/api/showroom/events").permitAll()
                        .requestMatchers("/api/showroom/productos/*/imagen").permitAll()
                        .requestMatchers(HttpMethod.GET, "/api/showroom/config/escalas-descuento").permitAll()
                        .requestMatchers(HttpMethod.GET, "/api/showroom/scan/*").permitAll()
                        // Healthcheck — el container Docker hace curl /health
                        // para saber si está UP. Sin esto, queda "starting" para
                        // siempre porque el endpoint responde 401 sin sesión.
                        .requestMatchers(HttpMethod.GET, "/api/showroom/health").permitAll()
                        .requestMatchers("/error").permitAll()
                        // Resto del API: requiere login.
                        .requestMatchers("/api/**").authenticated()
                        // Recursos estáticos (cuando se sirvan juntos al frontend).
                        .anyRequest().permitAll())
                .formLogin(AbstractHttpConfigurer::disable)
                .httpBasic(AbstractHttpConfigurer::disable)
                .logout(logout -> logout
                        .logoutUrl("/api/auth/logout")
                        .logoutSuccessHandler(new HttpStatusReturningLogoutSuccessHandler(HttpStatus.NO_CONTENT))
                        .invalidateHttpSession(true)
                        .deleteCookies("JSESSIONID"))
                .exceptionHandling(ex -> ex
                        .authenticationEntryPoint((req, res, e) -> {
                            res.setStatus(HttpStatus.UNAUTHORIZED.value());
                            res.setContentType("application/json");
                            res.getWriter().write("{\"error\":\"No autenticado\"}");
                        })
                        .accessDeniedHandler((req, res, e) -> {
                            res.setStatus(HttpStatus.FORBIDDEN.value());
                            res.setContentType("application/json");
                            res.getWriter().write("{\"error\":\"Sin permiso\"}");
                        }));

        return http.build();
    }
}
