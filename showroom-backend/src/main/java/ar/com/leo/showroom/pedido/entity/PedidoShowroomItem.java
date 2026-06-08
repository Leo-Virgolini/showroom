package ar.com.leo.showroom.pedido.entity;

import jakarta.persistence.*;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;
import lombok.ToString;

import java.math.BigDecimal;

@Entity
@Table(name = "pedido_showroom_item")
@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
@ToString(exclude = "pedido")
public class PedidoShowroomItem {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "pedido_id", nullable = false)
    private PedidoShowroom pedido;

    @Column(nullable = false, length = 64)
    private String sku;

    @Column(length = 200)
    private String descripcion;

    @Column(nullable = false)
    private Integer cantidad;

    /** Precio unitario CON IVA — es lo que se manda a DUX en `precio` (la lista
     *  KT GASTRO está configurada en DUX como "incluye IVA"). */
    @Column(name = "precio_unitario", precision = 18, scale = 4)
    private BigDecimal precioUnitario;

    /** Porcentaje de IVA del producto al momento de crear el pedido — necesario para
     *  reconstruir el desglose sin-IVA en la pantalla /pedidos sin depender del
     *  catálogo (que puede haber cambiado). */
    @Column(name = "porc_iva", precision = 6, scale = 2)
    private BigDecimal porcIva;

    /** % de descuento de la línea — lo que se mandó a DUX como {@code porc_desc}.
     *  El {@code precioUnitario} se persiste BRUTO (sin descuento, = el `precio`
     *  que va a DUX); el subtotal neto de la línea se deriva aplicando este %.
     *  Null = sin descuento (incluye pedidos anteriores a esta columna, que
     *  quedan con su total histórico sin recalcular). */
    @Column(name = "descuento_porcentaje", precision = 6, scale = 2)
    private BigDecimal descuentoPorcentaje;

    /** Si el {@code precioUnitario} de este ítem lleva IVA. Lo define el perfil
     *  (menaje/maquinaria) del rubro del ítem al crear el pedido — un pedido
     *  mixto puede tener ítems con IVA (menaje) y sin IVA (maquinaria) bajo la
     *  misma forma de pago. Necesario para reconstruir el desglose por ítem en
     *  la pantalla /pedidos sin asumir un único régimen para todo el pedido.
     *  Nullable: los pedidos anteriores a esta columna caen al flag global de
     *  la forma de pago ({@code formaPagoAplicaIva}). */
    @Column(name = "aplica_iva")
    private Boolean aplicaIva;

    /** Texto libre que viaja al campo {@code comentarios} de la línea en el
     *  payload DUX. Persistido para reconstruir el detalle del pedido sin
     *  consultar a DUX. Usado principalmente con el SKU comodín (ver
     *  {@code dux.sku-producto-generico}) para describir productos que no
     *  están en catálogo KT GASTRO. Null cuando no aplica. */
    @Column(name = "comentarios", length = 500)
    private String comentarios;
}
