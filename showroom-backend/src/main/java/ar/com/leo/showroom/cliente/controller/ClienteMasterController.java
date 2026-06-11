package ar.com.leo.showroom.cliente.controller;

import ar.com.leo.showroom.cliente.dto.ActualizarClienteRequestDTO;
import ar.com.leo.showroom.cliente.dto.ClienteAutocompletarDTO;
import ar.com.leo.showroom.cliente.entity.ClienteMaster;
import ar.com.leo.showroom.cliente.service.ClienteMasterService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
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

    /** Autocompletado del pedido por CUIT: devuelve los datos del cliente con
     *  ese documento (maestro o, en su defecto, el último pedido) para pre-llenar
     *  el formulario. 404 si no hay coincidencias — el operador completa a mano. */
    @GetMapping("/por-cuit/{nroDoc}")
    public ResponseEntity<ClienteAutocompletarDTO> buscarPorCuit(@PathVariable Long nroDoc) {
        return service.buscarParaAutocompletar(nroDoc)
                .map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.notFound().build());
    }

    /** Autocompletado del pedido por razón social / nombre: devuelve los clientes
     *  guardados que coinciden con el texto, para que el operador elija uno y
     *  precargue sus datos. Lista vacía si no hay coincidencias o el texto es muy
     *  corto. */
    @GetMapping("/buscar")
    public java.util.List<ClienteAutocompletarDTO> buscarPorRazonSocial(
            @org.springframework.web.bind.annotation.RequestParam(value = "q", required = false) String q) {
        return service.buscarPorRazonSocial(q);
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

    /** Soft-delete masivo — oculta del listado todos los clientes de la lista de
     *  teléfonos. Body: {@code { "telefonos": ["...", "..."] }}. Responde con la
     *  cantidad de clientes marcados. */
    @org.springframework.web.bind.annotation.PostMapping("/eliminar-masivo")
    public ResponseEntity<java.util.Map<String, Integer>> eliminarMasivo(
            @RequestBody EliminarMasivoRequest body,
            Authentication auth) {
        int eliminados = service.eliminarMasivo(
                body != null ? body.telefonos() : null,
                auth != null ? auth.getName() : null);
        return ResponseEntity.ok(java.util.Map.of("eliminados", eliminados));
    }

    /** Body del borrado masivo. */
    public record EliminarMasivoRequest(java.util.List<String> telefonos) {}
}
