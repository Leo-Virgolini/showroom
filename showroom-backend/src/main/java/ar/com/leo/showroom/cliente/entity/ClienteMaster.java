package ar.com.leo.showroom.cliente.entity;

import jakarta.persistence.*;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;

/**
 * Maestro editable de clientes. Sirve para que el operador pueda corregir o
 * completar datos (nombre/email/rubro/notas) sin tener que tocar los
 * presupuestos y pedidos históricos, que son snapshots inmutables.
 *
 * <p>La vista de /clientes hace LEFT JOIN lógico por {@link #telefonoNormalizado}:
 * si existe un master para ese cliente, sus campos pisan los datos derivados
 * del último movimiento; si no, se siguen mostrando los del último movimiento
 * como antes. Esto permite editar sin alterar el histórico (un PDF de un
 * presupuesto viejo sigue mostrando el nombre con el que se generó).
 *
 * <p>La PK lógica es el teléfono normalizado (solo dígitos) — usamos un id
 * auto-incremental como PK física por convención JPA + para no tener que
 * regenerar referencias si en el futuro hubiera que normalizar distinto.
 */
@Entity
@Table(name = "cliente_master", indexes = {
        @Index(name = "uk_cliente_master_telefono",
                columnList = "telefono_normalizado", unique = true),
})
@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class ClienteMaster {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    /** Teléfono normalizado a solo dígitos — misma normalización que se usa
     *  para agrupar movimientos en {@code PresupuestoComercialService#claveTelefono}.
     *  Sin esto "11-12345678" y "1112345678" caerían en masters distintos. */
    @Column(name = "telefono_normalizado", length = 50, nullable = false, unique = true)
    private String telefonoNormalizado;

    @Column(name = "nombre", length = 150)
    private String nombre;

    @Column(name = "email", length = 150)
    private String email;

    /** Rubro comercial — puede ser uno de los predefinidos
     *  ('bar', 'restaurant', ...) o un texto libre cuando el operador eligió
     *  "Otros". Mismo modelo que el campo equivalente en presupuestos/pedidos. */
    @Column(name = "rubro", length = 100)
    private String rubro;

    /** Notas libres del operador — útiles como CRM ligero (preferencias del
     *  cliente, frecuencia de compra, contacto preferido, etc.). Sin límite
     *  estricto pero pensado para texto corto. */
    @Lob
    @Column(name = "notas", columnDefinition = "TEXT")
    private String notas;

    /** Operador que hizo la última edición — snapshot del username logueado.
     *  Nullable para tolerar inserts iniciales sin auth en tests. */
    @Column(name = "actualizado_por_usuario_id")
    private Long actualizadoPorUsuarioId;

    @Column(name = "actualizado_at", nullable = false)
    private Instant actualizadoAt;
}
