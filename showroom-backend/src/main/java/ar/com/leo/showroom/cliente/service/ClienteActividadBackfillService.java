package ar.com.leo.showroom.cliente.service;

import ar.com.leo.showroom.cliente.entity.ClienteMaster;
import ar.com.leo.showroom.cliente.repository.ClienteMasterRepository;
import ar.com.leo.showroom.pedido.entity.PedidoShowroom;
import ar.com.leo.showroom.pedido.repository.PedidoShowroomRepository;
import ar.com.leo.showroom.presupuesto.entity.PresupuestoComercial;
import ar.com.leo.showroom.presupuesto.repository.PresupuestoComercialRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Backfill one-shot que prepara la vista /clientes para paginar/ordenar en SQL:
 *
 * <ol>
 *   <li>Deriva {@code cliente_telefono_normalizado} (solo dígitos) en los
 *       presupuestos y pedidos que aún no lo tienen.</li>
 *   <li>Crea un {@link ClienteMaster} por cada teléfono con historial que no
 *       tenga uno todavía (clientes legacy), sembrando los datos del movimiento
 *       más reciente. NO setea CUIT para no chocar el índice único con datos
 *       legacy duplicados (se completa solo al próximo pedido o edición).</li>
 *   <li>Recalcula la actividad materializada (contadores, último movimiento,
 *       etc.) de todos los masters.</li>
 * </ol>
 *
 * <p>Idempotente: los UPDATE de normalización solo tocan filas sin valor, la
 * creación solo cubre los masters faltantes y, si no hubo nada nuevo que
 * normalizar ni crear, se saltea el recálculo masivo (los movimientos en vivo
 * ya mantienen la actividad al día). Lo dispara {@link ClienteActividadBackfillRunner}
 * al arrancar la aplicación.
 */
@Service
@Slf4j
@RequiredArgsConstructor
public class ClienteActividadBackfillService {

    private final PresupuestoComercialRepository presupuestoRepository;
    private final PedidoShowroomRepository pedidoRepository;
    private final ClienteMasterRepository masterRepository;
    private final ClienteMasterService clienteMasterService;

    @Transactional
    public void ejecutar() {
        int normalizados = presupuestoRepository.backfillTelefonoNormalizado()
                + pedidoRepository.backfillTelefonoNormalizado();
        int creados = crearMastersFaltantes();

        if (normalizados == 0 && creados == 0) {
            log.debug("Backfill actividad de clientes: nada pendiente.");
            return;
        }

        // Recalcular la actividad de TODOS los masters (incluidos los recién
        // creados) ahora que los teléfonos normalizados están poblados.
        List<ClienteMaster> masters = masterRepository.findAll();
        for (ClienteMaster m : masters) {
            clienteMasterService.aplicarActividad(m, m.getTelefonoNormalizado());
        }
        masterRepository.saveAll(masters);

        log.info("Backfill actividad de clientes: {} movimientos normalizados, "
                + "{} masters creados, {} masters recalculados.",
                normalizados, creados, masters.size());
    }

    /** Crea un master por cada teléfono con historial que aún no tenga uno.
     *  Devuelve cuántos creó. */
    private int crearMastersFaltantes() {
        Set<String> conMaster = new HashSet<>(masterRepository.findAll().stream()
                .map(ClienteMaster::getTelefonoNormalizado)
                .toList());
        Set<String> conHistorial = new HashSet<>();
        conHistorial.addAll(presupuestoRepository.telefonosNormalizadosDistintos());
        conHistorial.addAll(pedidoRepository.telefonosNormalizadosDistintos());
        conHistorial.removeAll(conMaster);

        int creados = 0;
        for (String tel : conHistorial) {
            if (tel == null || tel.isBlank()) continue;
            crearMasterDesdeHistorial(tel);
            creados++;
        }
        return creados;
    }

    /** Crea el master sembrando nombre/email/rubro del movimiento más reciente y
     *  los datos de envío del último pedido. CUIT queda null a propósito (ver
     *  javadoc de la clase). */
    private void crearMasterDesdeHistorial(String tel) {
        PresupuestoComercial ultPresup = presupuestoRepository
                .findFirstByClienteTelefonoNormalizadoAndEliminadoAtIsNullOrderByCreadoAtDesc(tel).orElse(null);
        PedidoShowroom ultPedido = pedidoRepository
                .findFirstByClienteTelefonoNormalizadoOrderByCreadoAtDesc(tel).orElse(null);

        String nombre = null, email = null, rubro = null;
        boolean pedidoEsCanonico = ultPedido != null
                && (ultPresup == null || !ultPresup.getCreadoAt().isAfter(ultPedido.getCreadoAt()));
        if (pedidoEsCanonico) {
            nombre = ultPedido.getNombre();
            email = ultPedido.getEmail();
            rubro = ultPedido.getRubro();
        } else if (ultPresup != null) {
            nombre = ultPresup.getClienteNombre();
            email = ultPresup.getClienteEmail();
            rubro = ultPresup.getRubro();
        }

        // Datos de facturación/envío: solo existen en pedidos.
        String tipoDoc = ultPedido != null ? ultPedido.getTipoDoc() : null;
        String domicilio = ultPedido != null ? ultPedido.getDomicilio() : null;
        String codigoProvincia = ultPedido != null ? ultPedido.getCodigoProvincia() : null;
        String idLocalidad = ultPedido != null ? ultPedido.getIdLocalidad() : null;

        clienteMasterService.ensureClienteBackfill(tel, nombre, email, rubro,
                tipoDoc, null, domicilio, codigoProvincia, idLocalidad);
    }
}
