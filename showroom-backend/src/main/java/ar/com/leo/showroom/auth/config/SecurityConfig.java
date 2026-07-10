package ar.com.leo.showroom.auth.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.security.authentication.AuthenticationManager;
import org.springframework.security.config.annotation.authentication.configuration.AuthenticationConfiguration;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.Customizer;
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
 *    <li>Sesiones via cookie {@code SESSION} de Spring Session (HttpOnly), persistidas en
 *        MySQL via Spring Session JDBC con timeout configurado en
 *        {@code application.properties} (30 días por default). La auto-config
 *        del starter {@code spring-boot-starter-session-jdbc} aplica
 *        {@code @EnableJdbcHttpSession} automáticamente — las sesiones
 *        sobreviven a restarts del backend (deploy, crash, OOMKill) sin
 *        desloguear a los operadores.</li>
 *    <li>Login via {@code POST /api/auth/login} (manejado por {@code AuthController}).</li>
 *    <li>Logout via {@code POST /api/auth/logout} (manejado por Spring Security).</li>
 *    <li>CSRF activo con cookie {@code XSRF-TOKEN} (header {@code X-XSRF-TOKEN}).
 *        Angular lo manda automáticamente con {@code provideHttpClient(withXsrfConfiguration)}.</li>
 *    <li>Endpoints públicos: {@code /api/auth/login},
 *        {@code /api/auth/me}, {@code GET /api/showroom/health} (healthcheck),
 *        {@code /api/showroom/visor/t/**} (visor del cliente, validado por token),
 *        {@code /error}. Scan, formas de pago, escalas, rubros e imágenes globales
 *        requieren autenticación. El resto del API requiere login.</li>
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
                        // El visor es público y sin sesión → su POST también va exento.
                        .ignoringRequestMatchers("/api/auth/login", "/api/showroom/visor/t/**"))
                // CORS unificado: toma el bean CorsConfigurationSource (ver
                // CorsConfig). El filtro CORS de Security maneja el preflight
                // OPTIONS antes de la autorización — un solo lugar para CORS.
                .cors(Customizer.withDefaults())
                .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.IF_REQUIRED))
                .authorizeHttpRequests(auth -> auth
                        // Login y chequeo de sesión.
                        .requestMatchers("/api/auth/login", "/api/auth/me").permitAll()
                        // Healthcheck del container.
                        .requestMatchers(HttpMethod.GET, "/api/showroom/health").permitAll()
                        // Visor del cliente: ÚNICA superficie pública de negocio.
                        // Todo se valida por token dentro del controller.
                        .requestMatchers("/api/showroom/visor/t/**").permitAll()
                        .requestMatchers("/error").permitAll()
                        // Resto del API: requiere login. (scan, formas-pago,
                        // escalas, rubros e imágenes globales ya NO son públicos.)
                        .requestMatchers("/api/**").authenticated()
                        // Fallback seguro: todo lo que no sea /api/** (hoy no hay
                        // otros mappings — el frontend estático lo sirve nginx) se
                        // deniega por default. Si mañana se agrega un mapping
                        // no-/api, queda protegido salvo que se exima explícito.
                        .anyRequest().denyAll())
                .formLogin(AbstractHttpConfigurer::disable)
                .httpBasic(AbstractHttpConfigurer::disable)
                .logout(logout -> logout
                        .logoutUrl("/api/auth/logout")
                        .logoutSuccessHandler(new HttpStatusReturningLogoutSuccessHandler(HttpStatus.NO_CONTENT))
                        .invalidateHttpSession(true)
                        // Spring Session usa la cookie "SESSION" (no JSESSIONID);
                        // borrarla del browser tras el logout evita dejarla huérfana.
                        .deleteCookies("SESSION"))
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
