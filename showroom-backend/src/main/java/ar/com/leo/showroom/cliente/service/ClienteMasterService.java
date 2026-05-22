package ar.com.leo.showroom.cliente.service;

import ar.com.leo.showroom.auth.repository.UsuarioRepository;
import ar.com.leo.showroom.cliente.dto.ActualizarClienteRequestDTO;
import ar.com.leo.showroom.cliente.entity.ClienteMaster;
import ar.com.leo.showroom.cliente.repository.ClienteMasterRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * Servicio del maestro de clientes — gestiona la entidad
 * {@link ClienteMaster} que sobreescribe los datos derivados del historial.
 *
 * <p>El upsert se hace por teléfono normalizado (solo dígitos): así si el
 * operador cargó dos presupuestos con el mismo teléfono escrito distinto
 * ("11-1234" vs "1112-34"), sigue siendo un solo cliente y se edita un solo
 * row.
 */
@Service
@RequiredArgsConstructor
public class ClienteMasterService {

    private final ClienteMasterRepository repository;
    private final UsuarioRepository usuarioRepository;

    /** Upsert: si existe master para ese teléfono lo actualiza, sino crea uno.
     *  Devuelve la entidad final persistida. */
    @Transactional
    public ClienteMaster upsert(ActualizarClienteRequestDTO datos, String username) {
        String telefonoNorm = normalizar(datos.telefono());
        if (telefonoNorm == null) {
            throw new IllegalArgumentException(
                    "El teléfono debe tener al menos un dígito para identificar al cliente.");
        }
        ClienteMaster master = repository.findByTelefonoNormalizado(telefonoNorm)
                .orElseGet(() -> ClienteMaster.builder()
                        .telefonoNormalizado(telefonoNorm)
                        .build());
        master.setNombre(blankToNull(datos.nombre()));
        master.setEmail(blankToNull(datos.email()));
        master.setRubro(blankToNull(datos.rubro()));
        master.setNotas(blankToNull(datos.notas()));
        master.setActualizadoPorUsuarioId(usuarioIdDe(username));
        master.setActualizadoAt(Instant.now());
        return repository.save(master);
    }

    /** Devuelve TODOS los masters indexados por teléfono normalizado, para
     *  hacer el merge en memoria al armar la vista de /clientes. La cantidad
     *  esperada de clientes es manejable — no paginamos. */
    public Map<String, ClienteMaster> cargarTodosIndexados() {
        return repository.findAll().stream()
                .collect(Collectors.toMap(
                        ClienteMaster::getTelefonoNormalizado,
                        m -> m,
                        // Defensivo: en caso de duplicados por el índice único
                        // fallando (concurrencia), nos quedamos con el más reciente.
                        (a, b) -> a.getActualizadoAt().isAfter(b.getActualizadoAt()) ? a : b));
    }

    /** Misma normalización que usa {@code PresupuestoComercialService#claveTelefono}.
     *  Centralizar acá la lógica + dejarla {@code public static} sería más DRY,
     *  pero por ahora la duplicamos para no introducir un acoplamiento cruzado
     *  entre paquetes. */
    public static String normalizar(String telefono) {
        if (!StringUtils.hasText(telefono)) return null;
        String soloDigitos = telefono.replaceAll("\\D+", "");
        return soloDigitos.isEmpty() ? null : soloDigitos;
    }

    private static String blankToNull(String v) {
        return StringUtils.hasText(v) ? v.trim() : null;
    }

    private Long usuarioIdDe(String username) {
        if (username == null) return null;
        return usuarioRepository.findByUsername(username)
                .map(u -> u.getId())
                .orElse(null);
    }
}
