package ar.com.leo.showroom.catalogo.entity;

import jakarta.persistence.*;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Entity
@Table(name = "localidad", indexes = {
        @Index(name = "idx_localidad_provincia", columnList = "id_provincia")
})
@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class Localidad {

    @Id
    private Long id;

    @Column(name = "id_provincia", nullable = false)
    private Long idProvincia;

    @Column(name = "nombre", length = 100, nullable = false)
    private String nombre;

    @Column(name = "cod_postal", length = 20)
    private String codPostal;
}
