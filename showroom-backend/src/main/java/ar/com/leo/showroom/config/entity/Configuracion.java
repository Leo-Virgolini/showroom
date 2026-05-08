package ar.com.leo.showroom.config.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

/**
 * Configuración runtime de la app (key-value). Pensada para valores que el
 * operador puede cambiar desde la pantalla de configuración sin reiniciar el
 * backend (ej. destinatario del email de picking).
 *
 * <p>El mismo valor puede tener un default en {@code application.properties} —
 * el service correspondiente decide si la entrada de la BD pisa al
 * {@code @Value} o si la BD es solo un override opcional.
 */
@Entity
@Table(name = "configuracion")
@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class Configuracion {

    @Id
    @Column(name = "clave", length = 64, nullable = false)
    private String clave;

    @Column(name = "valor", length = 1024, nullable = false)
    private String valor;
}
