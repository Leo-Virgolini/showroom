package ar.com.leo.showroom.config.service;

import ar.com.leo.showroom.common.exception.ConflictException;
import ar.com.leo.showroom.common.exception.NotFoundException;
import ar.com.leo.showroom.config.entity.FormaPago;
import ar.com.leo.showroom.config.repository.FormaPagoRepository;
import ar.com.leo.showroom.showroom.dto.FormaPagoDTO;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.Optional;

/**
 * CRUD de formas de pago configurables desde la pantalla /configuracion.
 *
 * <p>El "delete" es soft (setea {@code activo=false}) — los pedidos históricos
 * que referencien una forma de pago siguen funcionando porque snapshotean el
 * nombre + recargo. Si el operador realmente quiere borrar, puede crear otra
 * forma con el mismo nombre (la unicidad se chequea solo entre activas vía
 * UI, pero a nivel BD el unique-index puede chocar — preferimos rename + soft
 * delete antes que hard delete).
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class FormaPagoService {

    private static final BigDecimal CIEN = new BigDecimal("100");

    private final FormaPagoRepository repository;

    /** Listado completo (activas + inactivas) — para la UI de configuración. */
    public List<FormaPago> listarTodas() {
        return repository.findAllByOrderByActivoDescOrdenAscIdAsc();
    }

    /** Listado activas — para el selector del operador en el carrito. */
    public List<FormaPago> listarActivas() {
        return repository.findByActivoTrueOrderByOrdenAscIdAsc();
    }

    /** Para el flujo de crearPedido: resolver una forma de pago por id. */
    public Optional<FormaPago> obtenerPorId(Long id) {
        return repository.findById(id);
    }

    @Transactional
    public FormaPago crear(FormaPagoDTO dto) {
        validar(dto);
        chequearNombreUnico(dto.nombre(), null);
        FormaPago entity = FormaPago.builder()
                .nombre(dto.nombre().trim())
                .recargoPorcentaje(dto.recargoPorcentaje())
                .recargoPorcentajeMaquinaria(dto.recargoPorcentajeMaquinaria())
                .cantidadCuotas(dto.cantidadCuotas())
                .aplicaIva(dto.aplicaIva() == null ? Boolean.TRUE : dto.aplicaIva())
                .aplicaIvaMaquinaria(dto.aplicaIvaMaquinaria())
                .activo(dto.activo() == null ? Boolean.TRUE : dto.activo())
                .orden(dto.orden() == null ? 0 : dto.orden())
                .precioReferencia(dto.precioReferencia() != null && dto.precioReferencia())
                .creadoAt(Instant.now())
                .build();
        FormaPago saved = repository.save(entity);
        log.info("Forma de pago creada: id={} nombre='{}' recargo={}% cuotas={} aplicaIva={}",
                saved.getId(), saved.getNombre(), saved.getRecargoPorcentaje(),
                saved.getCantidadCuotas(), saved.getAplicaIva());
        return saved;
    }

    @Transactional
    public FormaPago actualizar(Long id, FormaPagoDTO dto) {
        validar(dto);
        FormaPago entity = repository.findById(id)
                .orElseThrow(() -> new NotFoundException("Forma de pago no encontrada: " + id));
        chequearNombreUnico(dto.nombre(), id);
        entity.setNombre(dto.nombre().trim());
        entity.setRecargoPorcentaje(dto.recargoPorcentaje());
        entity.setRecargoPorcentajeMaquinaria(dto.recargoPorcentajeMaquinaria());
        entity.setCantidadCuotas(dto.cantidadCuotas());
        if (dto.aplicaIva() != null) entity.setAplicaIva(dto.aplicaIva());
        entity.setAplicaIvaMaquinaria(dto.aplicaIvaMaquinaria());
        if (dto.activo() != null) entity.setActivo(dto.activo());
        if (dto.orden() != null) entity.setOrden(dto.orden());
        if (dto.precioReferencia() != null) entity.setPrecioReferencia(dto.precioReferencia());
        FormaPago saved = repository.save(entity);
        log.info("Forma de pago actualizada: id={} nombre='{}' recargo={}% aplicaIva={} activo={} precioReferencia={}",
                saved.getId(), saved.getNombre(), saved.getRecargoPorcentaje(),
                saved.getAplicaIva(), saved.getActivo(), saved.getPrecioReferencia());
        return saved;
    }

    /** "Eliminar" = soft delete (activo=false). Los pedidos históricos preservan
     *  el snapshot de nombre + recargo en {@code pedido_showroom}. */
    @Transactional
    public void eliminar(Long id) {
        FormaPago entity = repository.findById(id)
                .orElseThrow(() -> new NotFoundException("Forma de pago no encontrada: " + id));
        entity.setActivo(false);
        repository.save(entity);
        log.info("Forma de pago desactivada (soft delete): id={} nombre='{}'",
                entity.getId(), entity.getNombre());
    }

    /**
     * Borrado definitivo (hard delete) de la forma. Es seguro: {@code pedido_showroom}
     * referencia la forma solo por {@code forma_pago_id} (columna suelta, sin FK) y
     * snapshotea nombre + recargo, así que los pedidos históricos no se ven afectados.
     */
    @Transactional
    public void eliminarDefinitivo(Long id) {
        FormaPago entity = repository.findById(id)
                .orElseThrow(() -> new NotFoundException("Forma de pago no encontrada: " + id));
        repository.delete(entity);
        log.info("Forma de pago ELIMINADA definitivamente: id={} nombre='{}'",
                entity.getId(), entity.getNombre());
    }

    private void validar(FormaPagoDTO dto) {
        if (dto.recargoPorcentaje() != null && dto.recargoPorcentaje().compareTo(CIEN.multiply(BigDecimal.TEN)) > 0) {
            // Sanity check: recargo > 1000% es probablemente un typo (3000% en vez de 30%).
            throw new IllegalArgumentException("Recargo mayor a 1000% — revisá el valor.");
        }
        if (dto.recargoPorcentaje() != null
                && dto.recargoPorcentaje().compareTo(new BigDecimal("-99.99")) < 0) {
            // Descuento mayor a 99,99% dejaría el precio en ~0 o negativo.
            throw new IllegalArgumentException("Descuento mayor a 99,99% — revisá el valor.");
        }
        if (dto.cantidadCuotas() != null && dto.cantidadCuotas() > 99) {
            throw new IllegalArgumentException("Cantidad de cuotas mayor a 99 — revisá el valor.");
        }
        BigDecimal recMaq = dto.recargoPorcentajeMaquinaria();
        if (recMaq != null && (recMaq.compareTo(CIEN.multiply(BigDecimal.TEN)) > 0
                || recMaq.compareTo(new BigDecimal("-99.99")) < 0)) {
            throw new IllegalArgumentException("Recargo de maquinaria fuera de rango (-99,99% a 1000%).");
        }
    }

    private void chequearNombreUnico(String nombre, Long excluirId) {
        if (!StringUtils.hasText(nombre)) return;
        repository.findByNombreIgnoreCase(nombre.trim()).ifPresent(existente -> {
            if (excluirId == null || !excluirId.equals(existente.getId())) {
                throw new ConflictException("Ya existe una forma de pago con ese nombre: '" + nombre + "'");
            }
        });
    }

    public static FormaPagoDTO toDTO(FormaPago f) {
        return new FormaPagoDTO(
                f.getId(),
                f.getNombre(),
                f.getRecargoPorcentaje(),
                f.getRecargoPorcentajeMaquinaria(),
                f.getCantidadCuotas(),
                f.getAplicaIva(),
                f.getAplicaIvaMaquinaria(),
                f.getActivo(),
                f.getOrden(),
                f.getPrecioReferencia() != null && f.getPrecioReferencia(),
                f.getCreadoAt() != null ? f.getCreadoAt().toString() : null);
    }
}
