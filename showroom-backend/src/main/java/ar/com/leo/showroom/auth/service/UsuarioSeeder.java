package ar.com.leo.showroom.auth.service;

import ar.com.leo.showroom.auth.repository.UsuarioRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

import java.security.SecureRandom;

/**
 * Crea un usuario admin inicial si la tabla {@code usuario} está vacía. Genera
 * un password random fuerte (16 caracteres hex) y lo loguea UNA SOLA VEZ con
 * nivel WARN. El password en texto plano nunca queda persistido en ningún
 * lugar — solo el hash BCrypt en la BD.
 *
 * <p>El operador tiene que mirar el log del primer arranque, copiar el
 * password generado, hacer login y cambiarlo desde la UI. A partir de ahí, las
 * credenciales viven exclusivamente en la BD.
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class UsuarioSeeder {

    private static final String USERNAME_INICIAL = "admin";
    private static final SecureRandom RANDOM = new SecureRandom();

    private final UsuarioRepository repository;
    private final UsuarioService usuarioService;

    @EventListener(ApplicationReadyEvent.class)
    public void seedSiHaceFalta() {
        if (repository.count() > 0) return;
        String passwordGenerado = generarPasswordRandom();
        usuarioService.crear(USERNAME_INICIAL, passwordGenerado, "Administrador", true);
        log.warn("");
        log.warn("============================================================");
        log.warn("USUARIO ADMIN CREADO (primer arranque)");
        log.warn("  username: {}", USERNAME_INICIAL);
        log.warn("  password: {}", passwordGenerado);
        log.warn("Copialo, hacé login y cambialo desde /configuracion → Mi cuenta.");
        log.warn("Este password no se vuelve a mostrar nunca más.");
        log.warn("============================================================");
        log.warn("");
    }

    /**
     * Password aleatorio de 16 caracteres hex (~64 bits de entropía). Suficiente
     * para que sea impredecible — tampoco hace falta más, porque está pensado
     * para usarse una sola vez.
     */
    private static String generarPasswordRandom() {
        byte[] bytes = new byte[8];
        RANDOM.nextBytes(bytes);
        StringBuilder sb = new StringBuilder(16);
        for (byte b : bytes) {
            sb.append(String.format("%02x", b));
        }
        return sb.toString();
    }
}
