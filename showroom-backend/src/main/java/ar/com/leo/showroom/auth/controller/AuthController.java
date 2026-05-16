package ar.com.leo.showroom.auth.controller;

import ar.com.leo.showroom.auth.dto.LoginRequestDTO;
import ar.com.leo.showroom.auth.dto.UsuarioActualDTO;
import ar.com.leo.showroom.auth.entity.Usuario;
import ar.com.leo.showroom.auth.repository.UsuarioRepository;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.authentication.AuthenticationManager;
import org.springframework.security.authentication.BadCredentialsException;
import org.springframework.security.authentication.DisabledException;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContext;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.context.HttpSessionSecurityContextRepository;
import org.springframework.security.web.context.SecurityContextRepository;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Endpoints de autenticación: login, logout (manejado por SecurityConfig)
 * y "quién soy". Los cambios de password se hacen via el endpoint de
 * reset administrativo en {@code UsuarioController}.
 */
@Slf4j
@RestController
@RequestMapping("/api/auth")
@RequiredArgsConstructor
public class AuthController {

    private final AuthenticationManager authenticationManager;
    private final UsuarioRepository usuarioRepository;

    /**
     * Persistencia del SecurityContext en la sesión HTTP — sin esto el login
     * "funciona" pero la cookie no queda con la auth, así que el siguiente
     * request vuelve a 401.
     */
    private final SecurityContextRepository securityContextRepository =
            new HttpSessionSecurityContextRepository();

    @PostMapping("/login")
    public ResponseEntity<UsuarioActualDTO> login(
            @RequestBody @Valid LoginRequestDTO body,
            HttpServletRequest request,
            HttpServletResponse response) {
        try {
            Authentication auth = authenticationManager.authenticate(
                    UsernamePasswordAuthenticationToken.unauthenticated(body.username(), body.password()));

            // Persistir el contexto en la sesión.
            SecurityContext context = SecurityContextHolder.createEmptyContext();
            context.setAuthentication(auth);
            SecurityContextHolder.setContext(context);
            securityContextRepository.saveContext(context, request, response);

            Usuario u = usuarioRepository.findByUsername(auth.getName()).orElseThrow();
            return ResponseEntity.ok(new UsuarioActualDTO(u.getId(), u.getUsername(), u.getNombre()));
        } catch (BadCredentialsException ex) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED)
                    .body(null);
        } catch (DisabledException ex) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN)
                    .body(null);
        }
    }

    /**
     * Devuelve los datos del usuario actualmente autenticado, o 401 si no hay
     * sesión. El frontend lo usa al iniciar para saber si tiene que mostrar
     * el login screen o el contenido normal.
     */
    @GetMapping("/me")
    public ResponseEntity<UsuarioActualDTO> me() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth == null || !auth.isAuthenticated() || "anonymousUser".equals(auth.getPrincipal())) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        return usuarioRepository.findByUsername(auth.getName())
                .map(u -> ResponseEntity.ok(new UsuarioActualDTO(u.getId(), u.getUsername(), u.getNombre())))
                .orElseGet(() -> ResponseEntity.status(HttpStatus.UNAUTHORIZED).build());
    }

}
