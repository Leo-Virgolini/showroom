package ar.com.leo.showroom.auth.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import jakarta.persistence.UniqueConstraint;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;

/**
 * Operador del showroom con acceso a la app. Cualquier usuario activo tiene
 * permisos completos sobre todos los endpoints (no manejamos roles diferenciados
 * — un solo nivel de privilegio "operador").
 *
 * <p>El password se guarda como hash BCrypt; nunca en plaintext. La validación
 * de credenciales pasa por Spring Security via {@code UserDetailsService}.
 */
@Entity
@Table(
        name = "usuario",
        uniqueConstraints = @UniqueConstraint(name = "uk_usuario_username", columnNames = "username")
)
@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class Usuario {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    /** Username único — case-sensitive. Se usa para login. */
    @Column(name = "username", nullable = false, length = 64)
    private String username;

    /** Hash BCrypt del password. Nunca el password plano. */
    @Column(name = "password_hash", nullable = false, length = 100)
    private String passwordHash;

    /** Nombre de display (para mostrar "Hola, Juan" en la UI). Opcional. */
    @Column(name = "nombre", length = 128)
    private String nombre;

    /** Si está deshabilitado, el login falla aunque las credenciales sean correctas. */
    @Column(name = "activo", nullable = false)
    private boolean activo = true;

    @Column(name = "creado_at", nullable = false, updatable = false)
    private Instant creadoAt;

    @Column(name = "actualizado_at")
    private Instant actualizadoAt;
}
