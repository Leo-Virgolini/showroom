package ar.com.leo.showroom.config.service;

import ar.com.leo.showroom.common.exception.ConflictException;
import ar.com.leo.showroom.common.exception.NotFoundException;
import ar.com.leo.showroom.config.entity.PerfilEtiquetas;
import ar.com.leo.showroom.config.repository.PerfilEtiquetasRepository;
import ar.com.leo.showroom.showroom.dto.PerfilEtiquetasDTO;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;
import tools.jackson.databind.ObjectMapper;

import java.time.Instant;
import java.util.List;
import java.util.Map;

/**
 * CRUD de perfiles de impresión de etiquetas — compartidos entre todas las PCs
 * del showroom. El "perfil activo" lo elige cada PC localmente (localStorage),
 * no se persiste acá.
 *
 * <p>El {@code config} es JSON opaco — el backend no conoce el shape; lo manda
 * y recibe como {@code Map<String,Object>} y lo serializa a TEXT en la BD.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class PerfilEtiquetasService {

    private final PerfilEtiquetasRepository repository;
    private final ObjectMapper objectMapper;

    public List<PerfilEtiquetasDTO> listar() {
        return repository.findAllByOrderByNombreAsc().stream()
                .map(this::toDTO)
                .toList();
    }

    @Transactional
    public PerfilEtiquetasDTO crear(PerfilEtiquetasDTO dto) {
        chequearNombreUnico(dto.nombre(), null);
        Instant now = Instant.now();
        PerfilEtiquetas entity = PerfilEtiquetas.builder()
                .nombre(dto.nombre().trim())
                .configJson(serializarConfig(dto.config()))
                .creadoAt(now)
                .actualizadoAt(now)
                .build();
        PerfilEtiquetas saved = repository.save(entity);
        log.info("Perfil de etiquetas creado: id={} nombre='{}'", saved.getId(), saved.getNombre());
        return toDTO(saved);
    }

    @Transactional
    public PerfilEtiquetasDTO actualizar(Long id, PerfilEtiquetasDTO dto) {
        PerfilEtiquetas entity = repository.findById(id)
                .orElseThrow(() -> new NotFoundException("Perfil de etiquetas no encontrado: " + id));
        chequearNombreUnico(dto.nombre(), id);
        entity.setNombre(dto.nombre().trim());
        entity.setConfigJson(serializarConfig(dto.config()));
        entity.setActualizadoAt(Instant.now());
        PerfilEtiquetas saved = repository.save(entity);
        return toDTO(saved);
    }

    @Transactional
    public void eliminar(Long id) {
        PerfilEtiquetas entity = repository.findById(id)
                .orElseThrow(() -> new NotFoundException("Perfil de etiquetas no encontrado: " + id));
        // No restringimos a "tiene que quedar al menos uno" desde backend — el
        // frontend lo valida (no muestra el botón si solo queda 1) y si igual
        // pasa, el operador puede recrear el perfil sin perder nada operativo.
        repository.delete(entity);
        log.info("Perfil de etiquetas eliminado: id={} nombre='{}'", id, entity.getNombre());
    }

    private void chequearNombreUnico(String nombre, Long excluirId) {
        if (!StringUtils.hasText(nombre)) return;
        repository.findByNombreIgnoreCase(nombre.trim()).ifPresent(existente -> {
            if (excluirId == null || !excluirId.equals(existente.getId())) {
                throw new ConflictException("Ya existe un perfil con ese nombre: '" + nombre + "'");
            }
        });
    }

    private String serializarConfig(Map<String, Object> config) {
        try {
            return objectMapper.writeValueAsString(config);
        } catch (Exception e) {
            throw new IllegalArgumentException("No se pudo serializar la config del perfil: " + e.getMessage(), e);
        }
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> deserializarConfig(String json) {
        try {
            return objectMapper.readValue(json, Map.class);
        } catch (Exception e) {
            log.warn("Config corrupta para perfil — devolviendo map vacío. JSON: {}", json);
            return Map.of();
        }
    }

    private PerfilEtiquetasDTO toDTO(PerfilEtiquetas p) {
        return new PerfilEtiquetasDTO(
                p.getId(),
                p.getNombre(),
                deserializarConfig(p.getConfigJson()),
                p.getCreadoAt() != null ? p.getCreadoAt().toString() : null,
                p.getActualizadoAt() != null ? p.getActualizadoAt().toString() : null);
    }
}
