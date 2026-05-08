package ar.com.leo.showroom.auth.service;

import ar.com.leo.showroom.auth.entity.Usuario;
import ar.com.leo.showroom.auth.repository.UsuarioRepository;
import ar.com.leo.showroom.common.exception.NotFoundException;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.List;
import java.util.regex.Pattern;

/**
 * CRUD de usuarios + cambio de password. La autenticación en sí (validar
 * credenciales en login) la hace Spring Security via UserDetailsServiceImpl.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class UsuarioService {

    /** Username válido: letras, dígitos, punto, guion y guion bajo. 3-64 chars. */
    private static final Pattern USERNAME_PATTERN = Pattern.compile("^[a-zA-Z0-9._-]{3,64}$");

    /** Mínimo 6 caracteres para el password. No queremos "1234" pero tampoco
     *  forzar reglas complejas a la operadora del showroom. */
    private static final int PASSWORD_MIN_LENGTH = 6;

    private final UsuarioRepository repository;
    private final PasswordEncoder passwordEncoder;

    @Transactional(readOnly = true)
    public List<Usuario> listar() {
        return repository.findAllByOrderByUsernameAsc();
    }

    @Transactional
    public Usuario crear(String username, String password, String nombre, boolean activo) {
        validarUsername(username);
        validarPassword(password);
        if (repository.existsByUsername(username)) {
            throw new IllegalArgumentException("El usuario '" + username + "' ya existe");
        }
        Instant ahora = Instant.now();
        Usuario u = Usuario.builder()
                .username(username.trim())
                .passwordHash(passwordEncoder.encode(password))
                .nombre(nombre == null ? null : nombre.trim())
                .activo(activo)
                .creadoAt(ahora)
                .actualizadoAt(ahora)
                .build();
        Usuario guardado = repository.save(u);
        log.info("Usuario creado: id={} username={}", guardado.getId(), guardado.getUsername());
        return guardado;
    }

    /**
     * Actualiza nombre/activo del usuario. El username y el password se manejan
     * con métodos dedicados (no es buena UX permitir cambiar el username, y el
     * password necesita el password viejo para confirmar).
     */
    @Transactional
    public Usuario actualizar(Long id, String nombre, boolean activo) {
        Usuario u = repository.findById(id)
                .orElseThrow(() -> new NotFoundException("Usuario no encontrado: " + id));
        u.setNombre(nombre == null ? null : nombre.trim());
        u.setActivo(activo);
        u.setActualizadoAt(Instant.now());
        return repository.save(u);
    }

    @Transactional
    public void eliminar(Long id) {
        Usuario u = repository.findById(id)
                .orElseThrow(() -> new NotFoundException("Usuario no encontrado: " + id));
        if (repository.count() <= 1) {
            throw new IllegalStateException("No se puede eliminar el último usuario activo");
        }
        repository.delete(u);
        log.info("Usuario eliminado: id={} username={}", id, u.getUsername());
    }

    /**
     * Reset de password administrativo: lo usa un usuario sobre OTRO usuario
     * (ej. olvidé el password de Juan, le seteo uno nuevo). No requiere el
     * password viejo.
     */
    @Transactional
    public void resetearPassword(Long id, String passwordNuevo) {
        Usuario u = repository.findById(id)
                .orElseThrow(() -> new NotFoundException("Usuario no encontrado: " + id));
        validarPassword(passwordNuevo);
        u.setPasswordHash(passwordEncoder.encode(passwordNuevo));
        u.setActualizadoAt(Instant.now());
        repository.save(u);
        log.info("Password reseteado: username={}", u.getUsername());
    }

    private static void validarUsername(String username) {
        if (username == null || !USERNAME_PATTERN.matcher(username.trim()).matches()) {
            throw new IllegalArgumentException(
                    "Username inválido: usá letras, dígitos, punto, guion o guion bajo (3-64 caracteres)");
        }
    }

    private static void validarPassword(String password) {
        if (password == null || password.length() < PASSWORD_MIN_LENGTH) {
            throw new IllegalArgumentException(
                    "Password inválido: mínimo " + PASSWORD_MIN_LENGTH + " caracteres");
        }
    }
}
