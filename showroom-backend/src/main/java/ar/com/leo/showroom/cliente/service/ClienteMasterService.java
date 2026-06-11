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
        // CUIT único: si el documento ya pertenece a OTRO cliente (otro teléfono),
        // rechazamos con un error claro (sino saltaría una violación de constraint
        // cruda al guardar). null/sin CUIT no valida (varios informales sin doc).
        if (datos.nroDoc() != null) {
            boolean cuitDeOtro = repository.findByNroDocOrderByActualizadoAtDesc(datos.nroDoc())
                    .stream()
                    .anyMatch(otro -> !otro.getTelefonoNormalizado().equals(telefonoNorm));
            if (cuitDeOtro) {
                throw new ar.com.leo.showroom.common.exception.ConflictException(
                        "Ese CUIT ya está asignado a otro cliente.");
            }
        }
        // razonSocial no se toca acá: el editor de /clientes no la gestiona; la
        // carga el flujo de pedido (registrarDesdePedido). Se preserva su valor.
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

    /**
     * Autocompletado por razón social / nombre: busca clientes del maestro (no
     * eliminados) cuyo razón social o nombre contenga el texto tipeado. Devuelve
     * los candidatos para que el operador elija uno y precargue los datos.
     * Limitado a {@code MAX_SUGERENCIAS_RAZON_SOCIAL} para no inundar el dropdown.
     */
    public java.util.List<ClienteAutocompletarDTO> buscarPorRazonSocial(String q) {
        if (!StringUtils.hasText(q)) return java.util.List.of();
        String texto = q.trim();
        if (texto.length() < 2) return java.util.List.of();
        return repository
                .buscarPorRazonSocialONombre(texto, org.springframework.data.domain.PageRequest.of(0, 10))
                .stream()
                .map(this::toAutocompletar)
                .toList();
    }

    /**
     * Guarda/actualiza el cliente formal a partir de un pedido recién creado.
     * Es lo que "guarda al cliente en la tabla" cuando se genera un pedido con
     * CUIT. Identifica la fila por CUIT (la más reciente con ese documento); si
     * no hay, por teléfono; si tampoco, crea una nueva. Solo pisa campos del
     * maestro con valores presentes en el pedido (no borra datos ya cargados).
     *
     * <p>Best-effort y aislado: se ejecuta en su propia transacción
     * ({@code REQUIRES_NEW}) para que un fallo acá NO tumbe la creación del
     * pedido. El caller igualmente lo envuelve en try/catch.
     */
    @Transactional(propagation = org.springframework.transaction.annotation.Propagation.REQUIRES_NEW)
    public void registrarDesdePedido(PedidoShowroom pedido, String username) {
        Long nroDoc = pedido.getNroDoc();
        String telefonoNorm = normalizar(pedido.getTelefono());
        // Sin CUIT ni teléfono no hay forma de identificar/crear al cliente.
        if (nroDoc == null && telefonoNorm == null) return;

        ClienteMaster master = null;
        if (nroDoc != null) {
            master = repository.findByNroDocOrderByActualizadoAtDesc(nroDoc)
                    .stream().findFirst().orElse(null);
        }
        if (master == null && telefonoNorm != null) {
            master = repository.findByTelefonoNormalizado(telefonoNorm).orElse(null);
        }
        if (master == null) {
            // Crear: el teléfono es la PK lógica (NOT NULL). Si no hay, no creamos.
            if (telefonoNorm == null) return;
            master = ClienteMaster.builder().telefonoNormalizado(telefonoNorm).build();
        }
        // No tocamos el teléfono de un master existente (evita chocar el índice
        // único de teléfono si el pedido trae otro número).
        setIfPresent(pedido.getApellidoRazonSocial(), master::setRazonSocial);
        setIfPresent(pedido.getNombre(), master::setNombre);
        setIfPresent(pedido.getEmail(), master::setEmail);
        setIfPresent(pedido.getRubro(), master::setRubro);
        setIfPresent(pedido.getTipoDoc(), master::setTipoDoc);
        if (nroDoc != null) master.setNroDoc(nroDoc);
        setIfPresent(pedido.getDomicilio(), master::setDomicilio);
        setIfPresent(pedido.getCodigoProvincia(), master::setCodigoProvincia);
        setIfPresent(pedido.getIdLocalidad(), master::setIdLocalidad);
        master.setActualizadoPorUsuarioId(usuarioIdDe(username));
        master.setActualizadoAt(Instant.now());
        repository.save(master);
    }

    private ClienteAutocompletarDTO toAutocompletar(ClienteMaster m) {
        return new ClienteAutocompletarDTO(
                m.getRazonSocial(), m.getNombre(), m.getEmail(),
                denormalizarTelefono(m.getTelefonoNormalizado()),
                m.getRubro(), m.getTipoDoc(), m.getNroDoc(), m.getDomicilio(),
                m.getCodigoProvincia(), m.getIdLocalidad());
    }

    private ClienteAutocompletarDTO toAutocompletar(PedidoShowroom p) {
        return new ClienteAutocompletarDTO(
                p.getApellidoRazonSocial(), p.getNombre(), p.getEmail(), p.getTelefono(),
                p.getRubro(), p.getTipoDoc(), p.getNroDoc(), p.getDomicilio(),
                p.getCodigoProvincia(), p.getIdLocalidad());
    }

    private static void setIfPresent(String value, java.util.function.Consumer<String> setter) {
        if (StringUtils.hasText(value)) setter.accept(value.trim());
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
