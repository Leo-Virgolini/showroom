package ar.com.leo.showroom.cliente.service;

import ar.com.leo.showroom.auth.repository.UsuarioRepository;
import ar.com.leo.showroom.cliente.dto.ActualizarClienteRequestDTO;
import ar.com.leo.showroom.cliente.dto.ClienteAutocompletarDTO;
import ar.com.leo.showroom.cliente.entity.ClienteMaster;
import ar.com.leo.showroom.cliente.event.ClienteMovimientoEvent;
import ar.com.leo.showroom.cliente.repository.ClienteMasterRepository;
import ar.com.leo.showroom.pedido.entity.PedidoShowroom;
import ar.com.leo.showroom.pedido.repository.PedidoShowroomRepository;
import ar.com.leo.showroom.presupuesto.entity.PresupuestoComercial;
import ar.com.leo.showroom.presupuesto.repository.PresupuestoComercialRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.event.TransactionPhase;
import org.springframework.transaction.event.TransactionalEventListener;
import org.springframework.util.StringUtils;

import java.time.Instant;
import java.util.Optional;

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
@Slf4j
@RequiredArgsConstructor
public class ClienteMasterService {

    private final ClienteMasterRepository repository;
    private final UsuarioRepository usuarioRepository;
    private final PresupuestoComercialRepository presupuestoRepository;
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
        ClienteMaster master = masterPorTelefonoONuevo(telefonoNorm);
        // CUIT único: si el documento ya pertenece a OTRO cliente hay que decidir
        // según su estado (sino saltaría una violación de constraint cruda al
        // guardar). null/sin CUIT no valida (varios informales sin doc).
        if (datos.nroDoc() != null) {
            for (ClienteMaster otro : repository.findByNroDocOrderByActualizadoAtDesc(datos.nroDoc())) {
                if (otro.getTelefonoNormalizado().equals(telefonoNorm)) continue; // es este mismo cliente
                if (otro.getEliminadoAt() == null) {
                    // Colisión real con un cliente ACTIVO: error claro en vez de
                    // dejar saltar la violación cruda del índice único.
                    throw new ar.com.leo.showroom.common.exception.ConflictException(
                            "Ese CUIT ya está asignado a otro cliente.");
                }
                // El CUIT lo retiene un cliente ELIMINADO (oculto del listado): se lo
                // liberamos para poder reasignarlo acá, sino chocaría el índice único
                // al guardar. Si ese cliente se reactiva luego, se le recarga el CUIT
                // a mano. Flush inmediato para liberar el índice antes del save final.
                otro.setNroDoc(null);
                repository.saveAndFlush(otro);
            }
        }
        master.setRazonSocial(blankToNull(datos.razonSocial()));
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
        ClienteMaster master = masterPorTelefonoONuevo(telefonoNorm);
        master.setActualizadoPorUsuarioId(usuarioIdDe(username));
        master.setActualizadoAt(Instant.now());
        master.setEliminadoAt(Instant.now());
        repository.save(master);
    }

    /** Soft-delete masivo: oculta del listado todos los clientes de la lista de
     *  teléfonos (sin tocar el historial). Devuelve cuántos se marcaron. Los
     *  teléfonos vacíos/inválidos se ignoran. */
    @Transactional
    public int eliminarMasivo(java.util.List<String> telefonos, String username) {
        if (telefonos == null || telefonos.isEmpty()) return 0;
        Long usuarioId = usuarioIdDe(username);
        Instant ahora = Instant.now();
        int eliminados = 0;
        for (String telefono : telefonos) {
            String telefonoNorm = normalizar(telefono);
            if (telefonoNorm == null) continue;
            ClienteMaster master = masterPorTelefonoONuevo(telefonoNorm);
            master.setActualizadoPorUsuarioId(usuarioId);
            master.setActualizadoAt(ahora);
            master.setEliminadoAt(ahora);
            repository.save(master);
            eliminados++;
        }
        return eliminados;
    }

    /**
     * Recalcula y persiste la ACTIVIDAD materializada del cliente (contadores,
     * primer/último movimiento, último total, ids de deep-link) leyendo el
     * estado real de sus presupuestos activos y pedidos. Idempotente: lee y
     * pisa, no incrementa — así un backfill o una doble llamada siempre dejan
     * los valores consistentes.
     *
     * <p>Lo invocan los flujos que cambian la actividad de un cliente en la
     * MISMA transacción que el movimiento (creación de presupuesto/pedido,
     * soft-delete de presupuesto) para que vea el cambio recién hecho. No-op si
     * el teléfono está vacío o si todavía no hay un master para ese cliente (el
     * master lo crean los upsert/backfill; el siguiente recálculo lo completa).
     */
    @Transactional
    public void recalcularActividad(String telefonoNormalizado) {
        String tel = normalizar(telefonoNormalizado);
        if (tel == null) return;
        ClienteMaster master = repository.findByTelefonoNormalizado(tel).orElse(null);
        if (master == null) return;
        aplicarActividad(master, tel);
        repository.save(master);
    }

    /**
     * Recalcula la actividad del cliente tras el COMMIT del movimiento que la
     * cambió ({@link ClienteMovimientoEvent}). Corre en una transacción nueva
     * ({@code REQUIRES_NEW}) ya finalizada la original: así VE tanto el movimiento
     * recién persistido como el master (que el upsert crea en su propia
     * transacción {@code REQUIRES_NEW}), evitando el problema de visibilidad bajo
     * REPEATABLE READ. Best-effort: un fallo no afecta al movimiento (ya
     * commiteado) y el backfill del próximo arranque lo deja consistente.
     */
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void onClienteMovimiento(ClienteMovimientoEvent evento) {
        try {
            recalcularActividad(evento.telefonoNormalizado());
        } catch (Exception e) {
            log.warn("No se pudo recalcular la actividad del cliente {}: {}",
                    evento.telefonoNormalizado(), e.getMessage());
        }
    }

    /** Setea los campos de actividad del master a partir del historial del
     *  cliente. No persiste — lo hace el caller (o la unidad de trabajo del
     *  backfill que guarda en lote). */
    void aplicarActividad(ClienteMaster master, String tel) {
        long cantPresup = presupuestoRepository.countByClienteTelefonoNormalizadoAndEliminadoAtIsNull(tel);
        long cantPedidos = pedidoRepository.countByClienteTelefonoNormalizado(tel);

        PresupuestoComercial ultPresup = presupuestoRepository
                .findFirstByClienteTelefonoNormalizadoAndEliminadoAtIsNullOrderByCreadoAtDesc(tel).orElse(null);
        PresupuestoComercial primPresup = presupuestoRepository
                .findFirstByClienteTelefonoNormalizadoAndEliminadoAtIsNullOrderByCreadoAtAsc(tel).orElse(null);
        PedidoShowroom ultPedido = pedidoRepository
                .findFirstByClienteTelefonoNormalizadoOrderByCreadoAtDesc(tel).orElse(null);
        PedidoShowroom primPedido = pedidoRepository
                .findFirstByClienteTelefonoNormalizadoOrderByCreadoAtAsc(tel).orElse(null);

        master.setCantidadPresupuestos((int) cantPresup);
        master.setCantidadPedidos((int) cantPedidos);
        master.setUltimoPresupuestoId(ultPresup != null ? ultPresup.getId() : null);
        master.setUltimoPedidoId(ultPedido != null ? ultPedido.getId() : null);

        Instant ultPresupAt = ultPresup != null ? ultPresup.getCreadoAt() : null;
        Instant ultPedidoAt = ultPedido != null ? ultPedido.getCreadoAt() : null;
        // El movimiento más reciente entre ambos tipos define el último mov.
        // En empate (mismo instante) gana el presupuesto, igual que el agregador
        // en memoria que reemplazaba el canónico solo si era ESTRICTAMENTE más nuevo.
        if (ultPedidoAt != null && (ultPresupAt == null || ultPedidoAt.isAfter(ultPresupAt))) {
            master.setUltimoMovimientoAt(ultPedidoAt);
        } else if (ultPresupAt != null) {
            master.setUltimoMovimientoAt(ultPresupAt);
        } else {
            master.setUltimoMovimientoAt(null);
        }

        master.setPrimerMovimientoAt(minInstant(
                primPresup != null ? primPresup.getCreadoAt() : null,
                primPedido != null ? primPedido.getCreadoAt() : null));
    }

    private static Instant minInstant(Instant a, Instant b) {
        if (a == null) return b;
        if (b == null) return a;
        return a.isBefore(b) ? a : b;
    }

    /**
     * Página de clientes (no eliminados) para la vista /clientes. El filtro
     * {@code q} se aplica como substring sobre nombre/razón social/email y, si
     * tiene dígitos, también sobre teléfono y CUIT. El orden lo trae el
     * {@link Pageable}. Como la actividad está materializada, es un SELECT
     * directo paginado (sin cruzar movimientos).
     */
    @Transactional(readOnly = true)
    public org.springframework.data.domain.Page<ClienteMaster> buscarClientes(
            String q, org.springframework.data.domain.Pageable pageable) {
        String qNorm = StringUtils.hasText(q) ? q.trim() : null;
        // Dígitos del query para los matches de teléfono/CUIT (vacío = no aplica
        // esos OR, así una búsqueda de texto no trae todos por el LIKE '%%').
        String qDigitos = qNorm == null ? "" : qNorm.replaceAll("\\D+", "");
        return repository.buscarPaginado(qNorm, qDigitos, pageable);
    }

    /**
     * Resuelve los datos de un cliente a partir de su CUIT/documento para
     * autocompletar el formulario de pedido. Busca SOLO en el maestro de clientes
     * ({@code ClienteMaster}) — NO cae al último pedido/presupuesto: el
     * autocompletado refleja exactamente lo que está guardado en la tabla de
     * clientes (decisión del usuario jun-2026). {@code Optional.empty()} si no hay
     * un cliente con ese documento (el operador completa a mano).
     */
    public Optional<ClienteAutocompletarDTO> buscarParaAutocompletar(Long nroDoc) {
        if (nroDoc == null) return Optional.empty();
        // El CUIT es único (índice único): a lo sumo una fila no-eliminada.
        return repository
                .findByNroDocAndEliminadoAtIsNull(nroDoc).stream()
                .findFirst()
                .map(this::toAutocompletar);
    }

    /**
     * Busca el cliente del maestro (no eliminado) que YA tiene este teléfono.
     * Lo usa el aviso "este teléfono ya pertenece a X" al crear un presupuesto/
     * pedido nuevo — el teléfono es la clave del cliente, así que reutilizarlo
     * fusiona los movimientos en ese cliente. {@code Optional.empty()} si nadie
     * lo tiene todavía.
     */
    public Optional<ClienteAutocompletarDTO> buscarPorTelefono(String telefono) {
        String telefonoNorm = normalizar(telefono);
        if (telefonoNorm == null) return Optional.empty();
        return repository.findByTelefonoNormalizado(telefonoNorm)
                .filter(m -> m.getEliminadoAt() == null)
                .map(this::toAutocompletar);
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
        // CUIT: solo lo seteamos si no pertenece YA a OTRO cliente (otro teléfono)
        // — sino violaría el índice único de CUIT. Si choca, dejamos el master sin
        // tocar su CUIT (el pedido igual se crea; este upsert es best-effort).
        if (nroDoc != null) {
            final String telMaster = master.getTelefonoNormalizado();
            boolean cuitDeOtro = repository.findByNroDocOrderByActualizadoAtDesc(nroDoc).stream()
                    .anyMatch(otro -> !otro.getTelefonoNormalizado().equals(telMaster));
            if (!cuitDeOtro) master.setNroDoc(nroDoc);
        }
        setIfPresent(pedido.getDomicilio(), master::setDomicilio);
        setIfPresent(pedido.getCodigoProvincia(), master::setCodigoProvincia);
        setIfPresent(pedido.getIdLocalidad(), master::setIdLocalidad);
        master.setActualizadoPorUsuarioId(usuarioIdDe(username));
        master.setActualizadoAt(Instant.now());
        // Un pedido nuevo reactiva al cliente: si estaba soft-deleted, vuelve a
        // aparecer en /clientes (tiene actividad otra vez).
        master.setEliminadoAt(null);
        repository.save(master);
    }

    private ClienteAutocompletarDTO toAutocompletar(ClienteMaster m) {
        return new ClienteAutocompletarDTO(
                m.getRazonSocial(), m.getNombre(), m.getEmail(),
                // El teléfono se guarda ya normalizado (solo dígitos); lo devolvemos
                // tal cual — el front lo muestra/normaliza igual que cualquier tipeo.
                m.getTelefonoNormalizado(),
                m.getRubro(), m.getTipoDoc(), m.getNroDoc(), m.getDomicilio(),
                m.getCodigoProvincia(), m.getIdLocalidad());
    }

    /**
     * Backfill: asegura que exista un master para un teléfono YA normalizado,
     * SIN pisar uno existente y SIN setear CUIT/razón social (para no chocar el
     * índice único de CUIT con datos legacy duplicados). Devuelve el master
     * (existente o recién creado). Corre en su propia transacción
     * ({@code REQUIRES_NEW}) para que una colisión rara (dos cargas concurrentes)
     * no envenene la transacción del listado.
     */
    @Transactional(propagation = org.springframework.transaction.annotation.Propagation.REQUIRES_NEW)
    public ClienteMaster ensureClienteBackfill(String telefonoNormalizado, String nombre,
                                               String email, String rubro, String tipoDoc,
                                               Long nroDoc, String domicilio,
                                               String codigoProvincia, String idLocalidad) {
        ClienteMaster existente = repository.findByTelefonoNormalizado(telefonoNormalizado).orElse(null);
        if (existente != null) return existente;
        // Copiamos los datos del historial al maestro UNA sola vez. razonSocial
        // queda null (los pedidos legacy traían placeholders). El nroDoc lo
        // resuelve el caller (null si chocaría con otro master por el índice único).
        ClienteMaster nuevo = ClienteMaster.builder()
                .telefonoNormalizado(telefonoNormalizado)
                .nombre(blankToNull(nombre))
                .email(blankToNull(email))
                .rubro(blankToNull(rubro))
                .tipoDoc(blankToNull(tipoDoc))
                .nroDoc(nroDoc)
                .domicilio(blankToNull(domicilio))
                .codigoProvincia(blankToNull(codigoProvincia))
                .idLocalidad(blankToNull(idLocalidad))
                .actualizadoAt(Instant.now())
                .build();
        return repository.save(nuevo);
    }

    /**
     * Asegura/actualiza el cliente en el maestro a partir de un presupuesto. El
     * maestro de clientes es la fuente única de la vista /clientes, así que cada
     * presupuesto también registra su cliente (keyed por teléfono — los
     * presupuestos no tienen CUIT ni razón social, esos campos NO se tocan acá:
     * se preservan si vienen de un pedido). Best-effort y aislado
     * ({@code REQUIRES_NEW}) para no tumbar el guardado del presupuesto.
     */
    @Transactional(propagation = org.springframework.transaction.annotation.Propagation.REQUIRES_NEW)
    public void registrarDesdePresupuesto(String telefono, String nombre, String email,
                                          String rubro, String username) {
        String telefonoNorm = normalizar(telefono);
        if (telefonoNorm == null) return; // sin teléfono no hay clave
        ClienteMaster master = masterPorTelefonoONuevo(telefonoNorm);
        setIfPresent(nombre, master::setNombre);
        setIfPresent(email, master::setEmail);
        setIfPresent(rubro, master::setRubro);
        master.setActualizadoPorUsuarioId(usuarioIdDe(username));
        master.setActualizadoAt(Instant.now());
        // Un movimiento nuevo reactiva al cliente: si estaba soft-deleted, vuelve
        // a aparecer en /clientes (tiene actividad otra vez).
        master.setEliminadoAt(null);
        repository.save(master);
    }

    private static void setIfPresent(String value, java.util.function.Consumer<String> setter) {
        if (StringUtils.hasText(value)) setter.accept(value.trim());
    }

    /** Master existente por teléfono normalizado, o uno nuevo (en memoria, sin
     *  persistir) con ese teléfono — base común de los upserts por teléfono. */
    private ClienteMaster masterPorTelefonoONuevo(String telefonoNorm) {
        return repository.findByTelefonoNormalizado(telefonoNorm)
                .orElseGet(() -> ClienteMaster.builder()
                        .telefonoNormalizado(telefonoNorm)
                        .build());
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
