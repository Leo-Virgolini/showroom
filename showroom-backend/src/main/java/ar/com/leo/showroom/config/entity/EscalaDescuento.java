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

import java.math.BigDecimal;

/**
 * Escalón de descuento por subtotal del carrito. Cuando el subtotal sin IVA
 * iguala o supera {@code umbralMin}, se aplica {@code porcentaje}. El sistema
 * elige el escalón con mayor {@code umbralMin} cuyo umbral fue alcanzado.
 *
 * <p>Hoy se siembran dos filas iniciales (5% y 10%) si la tabla está vacía
 * (ver {@code EscalaDescuentoService#inicializar}). El frontend lee la lista
 * y maneja N escalones genéricamente.
 */
@Entity
@Table(name = "escala_descuento", indexes = {
        @Index(name = "uk_escala_descuento_umbral", columnList = "umbral_min", unique = true)
})
@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class EscalaDescuento {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    /** Subtotal mínimo (sin IVA, en pesos) para que aplique este escalón. */
    @Column(name = "umbral_min", nullable = false, precision = 18, scale = 2)
    private BigDecimal umbralMin;

    /** Porcentaje de descuento aplicado al carrito completo. Ej: 5.00 = 5%. */
    @Column(name = "porcentaje", nullable = false, precision = 5, scale = 2)
    private BigDecimal porcentaje;
}
