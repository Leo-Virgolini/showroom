package ar.com.leo.showroom.cliente.service;

import ar.com.leo.showroom.auth.repository.UsuarioRepository;
import ar.com.leo.showroom.cliente.dto.ActualizarClienteRequestDTO;
import ar.com.leo.showroom.cliente.dto.ClienteAutocompletarDTO;
import ar.com.leo.showroom.cliente.entity.ClienteMaster;
import ar.com.leo.showroom.cliente.repository.ClienteMasterRepository;
import ar.com.leo.showroom.pedido.entity.PedidoShowroom;
import ar.com.leo.showroom.pedido.repository.PedidoShowroomRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;

import java.time.Instant;
import java.util.Comparator;
import java.util.Map;
import java.util.Optional;
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
    /** Para el fallback del autocompletado por CUIT: si no hay un maestro con ese
     *  documento, se toman los datos del último pedido con ese CUIT. */
    private final PedidoShowroomRepository pedidoRepository;

    /** Upsert: si existe master para ese teléfono lo actualiza, sino crea uno.
     *  Si el master estaba marcado como eliminado, al editarlo se reactiva
     *  (un edit explícito desde la UI indica que el operador quiere volver
     *  a ver al cliente). Devuelve la entidad final persistida. */
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
        master.setTipoDoc(blankToNull(datos.tipoDoc()));
        master.setNroDoc(datos.nroDoc());
        master.setDomicilio(blankToNull(datos.domicilio()));
        master.setCodigoProvincia(blankToNull(datos.codigoProvincia()));
        master.setIdLocalidad(blankToNull(datos.idLocalidad()));
        master.setActualizadoPorUsuarioId(usuarioIdDe(username));
        master.setActualizadoAt(Instant.now());
        master.setEliminadoAt(null);
        return repository.save(master);
    }

    /** Soft-delete por teléfono normalizado: oculta al cliente del listado de
     *  /clientes sin tocar el historial. Si todavía no había un master para
     *  ese teléfono, se crea uno solo con la marca de eliminado. */
    @Transactional
    public void eliminar(String telefono, String username) {
        String telefonoNorm = normalizar(telefono);
        if (telefonoNorm == null) {
            throw new IllegalArgumentException(
                    "El teléfono debe tener al menos un dígito para identificar al cliente.");
        }
        ClienteMaster master = repository.findByTelefonoNormalizado(telefonoNorm)
                .orElseGet(() -> ClienteMaster.builder()
                        .telefonoNormalizado(telefonoNorm)
                        .build());
        master.setActualizadoPorUsuarioId(usuarioIdDe(username));
        master.setActualizadoAt(Instant.now());
        master.setEliminadoAt(Instant.now());
        repository.save(master);
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

    /**
     * Resuelve los datos de un cliente a partir de su CUIT/documento para
     * autocompletar el formulario de pedido. Prioridad:
     * <ol>
     *   <li>Maestro de clientes ({@code ClienteMaster}) con ese {@code nroDoc} —
     *       el más reciente si hay varios (el CUIT no es único: distintos locales
     *       de una empresa entran con teléfonos distintos).</li>
     *   <li>Fallback: el último pedido con ese {@code nroDoc}.</li>
     * </ol>
     * {@code Optional.empty()} si no hay coincidencias (el operador completa a mano).
     */
    public Optional<ClienteAutocompletarDTO> buscarParaAutocompletar(Long nroDoc) {
        if (nroDoc == null) return Optional.empty();
        Optional<ClienteAutocompletarDTO> delMaestro = repository
                .findByNroDocAndEliminadoAtIsNull(nroDoc).stream()
                .max(Comparator.comparing(ClienteMaster::getActualizadoAt))
                .map(this::toAutocompletar);
        if (delMaestro.isPresent()) return delMaestro;
        return pedidoRepository.findFirstByNroDocOrderByCreadoAtDesc(nroDoc)
                .map(this::toAutocompletar);
    }

    private ClienteAutocompletarDTO toAutocompletar(ClienteMaster m) {
        return new ClienteAutocompletarDTO(
                m.getNombre(), m.getEmail(), denormalizarTelefono(m.getTelefonoNormalizado()),
                m.getRubro(), m.getTipoDoc(), m.getNroDoc(), m.getDomicilio(),
                m.getCodigoProvincia(), m.getIdLocalidad());
    }

    private ClienteAutocompletarDTO toAutocompletar(PedidoShowroom p) {
        return new ClienteAutocompletarDTO(
                p.getNombre(), p.getEmail(), p.getTelefono(), p.getRubro(),
                p.getTipoDoc(), p.getNroDoc(), p.getDomicilio(),
                p.getCodigoProvincia(), p.getIdLocalidad());
    }

    /** El maestro guarda el teléfono ya normalizado (solo dígitos). Para
     *  autocompletar lo devolvemos tal cual — el front lo muestra/normaliza
     *  igual que cualquier teléfono tipeado. */
    private static String denormalizarTelefono(String telefonoNormalizado) {
        return telefonoNormalizado;
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
