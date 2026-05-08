package ar.com.leo.showroom.auth.service;

import ar.com.leo.showroom.auth.entity.Usuario;
import ar.com.leo.showroom.auth.repository.UsuarioRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.userdetails.User;
import org.springframework.security.core.userdetails.UserDetails;
import org.springframework.security.core.userdetails.UserDetailsService;
import org.springframework.security.core.userdetails.UsernameNotFoundException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

/**
 * Adapter entre nuestra entity {@link Usuario} y la API de Spring Security.
 * Lo invoca el {@code AuthenticationManager} cuando se procesa el form de login.
 *
 * <p>Todos los usuarios tienen el mismo rol {@code ROLE_OPERADOR} — no
 * diferenciamos privilegios. Si en el futuro se necesitan, agregar un campo
 * {@code rol} a la entity.
 */
@Service
@RequiredArgsConstructor
public class UserDetailsServiceImpl implements UserDetailsService {

    private final UsuarioRepository repository;

    @Override
    @Transactional(readOnly = true)
    public UserDetails loadUserByUsername(String username) throws UsernameNotFoundException {
        Usuario u = repository.findByUsername(username)
                .orElseThrow(() -> new UsernameNotFoundException("Usuario no encontrado: " + username));
        return User.withUsername(u.getUsername())
                .password(u.getPasswordHash())
                .disabled(!u.isActivo())
                .authorities(List.of(new SimpleGrantedAuthority("ROLE_OPERADOR")))
                .build();
    }
}
