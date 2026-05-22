package ar.com.leo.showroom.cliente.controller;

import ar.com.leo.showroom.cliente.dto.ActualizarClienteRequestDTO;
import ar.com.leo.showroom.cliente.entity.ClienteMaster;
import ar.com.leo.showroom.cliente.service.ClienteMasterService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Endpoints del maestro de clientes. Hoy solo expone PUT (upsert) — el listado
 * sigue consumiendo {@code GET /presupuesto-comercial/clientes} que internamente
 * mergea estos masters con los datos derivados del historial.
 */
@RestController
@RequestMapping("/cliente-master")
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
}
