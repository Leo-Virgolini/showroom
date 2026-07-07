import { describe, it, expect } from 'vitest';
import { pedidoItemsAPresupuestoItems } from './pedido-a-carrito.util';
import { PedidoItemDetalle } from './models';

describe('pedidoItemsAPresupuestoItems', () => {
  const base: PedidoItemDetalle = {
    sku: '1016506', descripcion: 'VASO', cantidad: 3,
    precioUnitario: 1210, porcIva: 21, aplicaIva: true,
    descuentoPorcentaje: 10, imagenUrl: '/img/1016506', comentarios: null, rubro: 'MENAJE',
  };

  it('mapea campos y deriva pvp sin IVA desde porcIva', () => {
    const [r] = pedidoItemsAPresupuestoItems([base]);
    expect(r.sku).toBe('1016506');
    expect(r.pvpKtGastroConIva).toBe(1210);
    expect(r.pvpKtGastroSinIva).toBeCloseTo(1000, 6); // 1210 / 1.21
    expect(r.porcIva).toBe(21);
    expect(r.cantidad).toBe(3);
    expect(r.descuentoPorcentaje).toBe(10);
    expect(r.rubro).toBe('MENAJE');
    expect(r.imagenUrl).toBe('/img/1016506');
    expect(r.uid).toBeTruthy();
  });

  it('uid es único por ítem dentro de la lista', () => {
    const out = pedidoItemsAPresupuestoItems([base, { ...base, sku: '1043500' }]);
    expect(out[0].uid).not.toBe(out[1].uid);
  });

  it('descuento null → 0; conIva null → 0 y sinIva 0', () => {
    const [r] = pedidoItemsAPresupuestoItems([{ ...base, descuentoPorcentaje: null, precioUnitario: null }]);
    expect(r.descuentoPorcentaje).toBe(0);
    expect(r.pvpKtGastroConIva).toBe(0);
    expect(r.pvpKtGastroSinIva).toBe(0);
  });

  it('marca genérico cuando el sku coincide con el comodín', () => {
    const [r] = pedidoItemsAPresupuestoItems([{ ...base, sku: '9999990' }], '9999990');
    expect(r.generico).toBe(true);
  });
});
