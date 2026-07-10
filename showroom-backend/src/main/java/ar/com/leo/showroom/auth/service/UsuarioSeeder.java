package ar.com.leo.showroom.auth.service;

import ar.com.leo.showroom.auth.repository.UsuarioRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

import java.security.SecureRandom;

/**
 * Crea un usuario admin inicial si la tabla {@code usuario} está vacía. Genera
 * un password random fuerte (16 caracteres hex) y lo imprime UNA SOLA VEZ por
 * {@code System.out} (stdout). El password en texto plano nunca queda
 * persistido en ningún lugar — solo el hash BCrypt en la BD.
 *
 * <p>Se usa {@code System.out} adrede en vez del logger SLF4J: así el password
 * sale por stdout del contenedor (visible en {@code docker logs}/Coolify al
 * primer arranque) pero NO pasa por Logback, con lo que NO cae en el archivo de
 * log persistente (retención de días en la VPS). El operador lo copia del log
 * de arranque, hace login y lo cambia desde la UI; a partir de ahí las
 * credenciales viven exclusivamente en la BD.
 */
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
        // System.out (NO el logger): visible en stdout/Coolify pero fuera del
        // archivo de log persistente. Ver javadoc de la clase.
        System.out.println();
        System.out.println("============================================================");
        System.out.println("USUARIO ADMIN CREADO (primer arranque)");
        System.out.println("  username: " + USERNAME_INICIAL);
        System.out.println("  password: " + passwordGenerado);
        System.out.println("Copialo, hacé login y cambialo desde /configuracion → Mi cuenta.");
        System.out.println("Este password no se vuelve a mostrar nunca más.");
        System.out.println("============================================================");
        System.out.println();
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
