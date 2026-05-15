package ar.com.leo.showroom.config.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Index;
import jakarta.persistence.Table;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;

/**
 * Perfil nombrado de configuración de impresión de etiquetas QR. Permite que el
 * operador tenga distintos setups (térmica chica, térmica ancha, A4 oficina) y
 * switchee entre ellos sin reconfigurar todo a mano.
 *
 * <p>La config se guarda como JSON opaco — el backend no necesita conocer el
 * shape (todo el render vive en el frontend). El nombre es único a nivel
 * sistema para que el dropdown del operador no muestre duplicados.
 *
 * <p>El "perfil activo" NO se persiste acá: cada PC elige su default y lo
 * guarda en localStorage propio. Los perfiles en sí (la lista) son
 * compartidos entre todas las PCs del showroom.
 */
@Entity
@Table(name = "perfil_etiquetas", indexes = {
        @Index(name = "uk_perfil_etiquetas_nombre", columnList = "nombre", unique = true)
})
@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class PerfilEtiquetas {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "nombre", nullable = false, length = 100)
    private String nombre;

    /** JSON con toda la config de impresión (geometría + tipografía + toggles).
     *  El backend lo trata como string opaco — el shape vive en el frontend
     *  ({@code ConfigPersistida}). TEXT en vez de VARCHAR para no limitar el
     *  tamaño si en el futuro se agregan más campos. */
    @Column(name = "config_json", nullable = false, columnDefinition = "TEXT")
    private String configJson;

    @Column(name = "creado_at", nullable = false)
    private Instant creadoAt;

    @Column(name = "actualizado_at", nullable = false)
    private Instant actualizadoAt;
}
