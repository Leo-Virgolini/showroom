package ar.com.leo.showroom.cliente.controller;

import ar.com.leo.showroom.cliente.dto.ActualizarClienteRequestDTO;
import ar.com.leo.showroom.cliente.entity.ClienteMaster;
import ar.com.leo.showroom.cliente.service.ClienteMasterService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Endpoints del maestro de clientes. Expone PUT (upsert) y DELETE (soft-delete)
 * — el listado sigue consumiendo {@code GET /presupuesto-comercial/clientes}
 * que internamente mergea estos masters con los datos derivados del historial
 * y filtra los que están marcados como eliminados.
 */
@RestController
@RequestMapping("/api/showroom/cliente-master")
@RequiredArgsConstructor
public class ClienteMasterController {

    private final ClienteMasterService service;

    /** Upsert por teléfono normalizado. Responde con la entidad final ya
     *  persistida — útil para que el frontend refleje los trims/normalizaciones
     *  aplicadas sin tener que pedir el listado completo. */
    @PutMapping
    public ResponseEntity<ClienteMaster> upsert(
            @RequestBody @Valid ActualizarClienteRequestDTO body,
            Authentication auth) {
        ClienteMaster guardado = service.upsert(body, auth != null ? auth.getName() : null);
        return ResponseEntity.ok(guardado);
    }

    /** Soft-delete por teléfono — oculta el cliente del listado sin tocar el
     *  historial. El path acepta el teléfono crudo (con guiones, espacios, etc.)
     *  y el service lo normaliza internamente. */
    @DeleteMapping("/{telefono}")
    public ResponseEntity<Void> eliminar(
            @PathVariable String telefono,
            Authentication auth) {
        service.eliminar(telefono, auth != null ? auth.getName() : null);
        return ResponseEntity.noContent().build();
    }
}
