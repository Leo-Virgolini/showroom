package ar.com.leo.showroom.config.service;

import ar.com.leo.showroom.config.entity.EscalaDescuento;
import ar.com.leo.showroom.config.repository.EscalaDescuentoRepository;
import ar.com.leo.showroom.showroom.dto.EscalaDescuentoDTO;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.List;

@Slf4j
@Service
@RequiredArgsConstructor
public class EscalaDescuentoService {

    private static final BigDecimal CIEN = new BigDecimal("100");

    private final EscalaDescuentoRepository repository;

    /** Lista de escalones, ordenados por umbral ascendente. */
    public List<EscalaDescuento> listar() {
        return repository.findAllByOrderByUmbralMinAsc();
    }

    /**
     * Reemplaza atómicamente la lista de escalones por la recibida. Sin filas
     * de "merge" — borrar y volver a insertar es más simple que mantener IDs
     * estables cuando el operador agrega/quita filas en la UI. La operación es
     * transaccional: o se aplica entera o no se aplica.
     *
     * <p>Validaciones (todas obligatorias para evitar configuraciones que
     * rompan el cálculo del descuento o muestren la UI inconsistente):
     * <ul>
     *   <li>{@code umbralMin} y {@code porcentaje} no nulos.
     *   <li>{@code umbralMin > 0}.
     *   <li>{@code 0 < porcentaje < 100}.
     *   <li>Sin umbrales duplicados (dos escalones con el mismo umbral).
     * </ul>
     */
    @Transactional
    public List<EscalaDescuento> reemplazar(List<EscalaDescuentoDTO> nuevas) {
        if (nuevas == null) nuevas = List.of();
        validar(nuevas);
        repository.deleteAllInBatch();
        // flush implícito por la transacción; el insert siguiente puede chocar
        // contra el unique de umbral_min si no se vacía antes.
        repository.flush();
        for (EscalaDescuentoDTO dto : nuevas) {
            repository.save(EscalaDescuento.builder()
                    .umbralMin(dto.umbralMin())
                    .porcentaje(dto.porcentaje())
                    .build());
        }
        log.info("Escalones de descuento reemplazados: {} filas", nuevas.size());
        return repository.findAllByOrderByUmbralMinAsc();
    }

    private void validar(List<EscalaDescuentoDTO> nuevas) {
        // Comparar umbrales con compareTo (no equals) — equals considera la
        // escala, así que "5" y "5.00" se verían distintos aunque la BD
        // (DECIMAL(18,2)) los guardaría iguales y reventaría el unique.
        List<BigDecimal> umbralesVistos = new ArrayList<>();
        for (int i = 0; i < nuevas.size(); i++) {
            EscalaDescuentoDTO e = nuevas.get(i);
            String prefijo = "Escalón #" + (i + 1) + ": ";
            if (e.umbralMin() == null || e.porcentaje() == null) {
                throw new IllegalArgumentException(prefijo + "umbral y porcentaje son requeridos");
            }
            if (e.umbralMin().signum() <= 0) {
                throw new IllegalArgumentException(prefijo + "el umbral debe ser mayor a 0");
            }
            if (e.porcentaje().signum() <= 0 || e.porcentaje().compareTo(CIEN) >= 0) {
                throw new IllegalArgumentException(prefijo + "el porcentaje debe estar entre 0 y 100 (exclusivos)");
            }
            for (BigDecimal previo : umbralesVistos) {
                if (previo.compareTo(e.umbralMin()) == 0) {
                    throw new IllegalArgumentException(prefijo + "umbral duplicado (" + e.umbralMin() + ")");
                }
            }
            umbralesVistos.add(e.umbralMin());
        }
    }
}
