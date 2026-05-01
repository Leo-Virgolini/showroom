package ar.com.leo.showroom.catalogo.entity;

import jakarta.persistence.*;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;

/**
 * Provincia persistida desde DUX. PK = id de DUX (no autogenerado).
 * El campo {@link #localidadesSincronizadasAt} marca si ya se trajeron las localidades:
 * null → no se intentó; not null → se descargaron y guardaron al menos una vez.
 */
@Entity
@Table(name = "provincia", indexes = {
        @Index(name = "idx_provincia_cod_iso", columnList = "cod_iso", unique = true)
})
@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class Provincia {

    @Id
    private Long id;

    /** Código ISO ("B", "C", ...) — lo que DUX espera como `codigo_provincia` en el pedido. */
    @Column(name = "cod_iso", length = 10, nullable = false, unique = true)
    private String codIso;

    @Column(name = "nombre", length = 100, nullable = false)
    private String nombre;

    @Column(name = "id_pais")
    private Long idPais;

    @Column(name = "pais", length = 50)
    private String pais;

    @Column(name = "localidades_sincronizadas_at")
    private Instant localidadesSincronizadasAt;
}
