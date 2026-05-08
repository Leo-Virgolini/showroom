package ar.com.leo.showroom.auth.controller;

import ar.com.leo.showroom.auth.dto.ActualizarUsuarioRequestDTO;
import ar.com.leo.showroom.auth.dto.CrearUsuarioRequestDTO;
import ar.com.leo.showroom.auth.dto.ResetPasswordRequestDTO;
import ar.com.leo.showroom.auth.dto.UsuarioDTO;
import ar.com.leo.showroom.auth.entity.Usuario;
import ar.com.leo.showroom.auth.service.UsuarioService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * CRUD de usuarios. Sólo accesible por usuarios autenticados (cualquier
 * operador puede crear/editar/eliminar otros — no diferenciamos roles).
 */
@RestController
@RequestMapping("/api/usuarios")
@RequiredArgsConstructor
public class UsuarioController {

    private final UsuarioService service;

    @GetMapping
    public List<UsuarioDTO> listar() {
        return service.listar().stream().map(UsuarioController::toDTO).toList();
    }

    @PostMapping
    public ResponseEntity<UsuarioDTO> crear(@RequestBody @Valid CrearUsuarioRequestDTO body) {
        Usuario u = service.crear(
                body.username(),
                body.password(),
                body.nombre(),
                body.activo() == null ? true : body.activo());
        return ResponseEntity.status(HttpStatus.CREATED).body(toDTO(u));
    }

    @PutMapping("/{id}")
    public UsuarioDTO actualizar(@PathVariable Long id, @RequestBody @Valid ActualizarUsuarioRequestDTO body) {
        return toDTO(service.actualizar(id, body.nombre(), body.activo()));
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Void> eliminar(@PathVariable Long id) {
        service.eliminar(id);
        return ResponseEntity.noContent().build();
    }

    /**
     * Reset administrativo de password (sin pedir el password viejo). Útil
     * cuando un operador olvida su clave y otro le setea una nueva.
     */
    @PostMapping("/{id}/reset-password")
    public ResponseEntity<Void> resetearPassword(
            @PathVariable Long id,
            @RequestBody @Valid ResetPasswordRequestDTO body) {
        service.resetearPassword(id, body.passwordNuevo());
        return ResponseEntity.noContent().build();
    }

    private static UsuarioDTO toDTO(Usuario u) {
        return new UsuarioDTO(u.getId(), u.getUsername(), u.getNombre(), u.isActivo());
    }
}
