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

    /** Texto libre que viaja al campo {@code comentarios} de la línea en el
     *  payload DUX. Persistido para reconstruir el detalle del pedido sin
     *  consultar a DUX. Usado principalmente con el SKU comodín (ver
     *  {@code dux.sku-producto-generico}) para describir productos que no
     *  están en catálogo KT GASTRO. Null cuando no aplica. */
    @Column(name = "comentarios", length = 500)
    private String comentarios;
}
