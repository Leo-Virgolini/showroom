import { carritoItemsAPresupuestoItems } from './carrito-a-presupuesto.util';
import { CarritoItem } from './models';

function item(partial: Partial<CarritoItem>): CarritoItem {
  return {
    sku: 'SKU1', descripcion: 'Producto', rubro: null,
    pvpKtGastroConIva: 121, pvpKtGastroSinIva: 100, porcIva: 21,
    stockTotal: 5, habilitado: true, imagenUrl: null, sincronizadoAt: null,
    itemKey: 'SKU1', cantidad: 2, comentarios: null, generico: false,
    ...partial,
  };
}

describe('carritoItemsAPresupuestoItems', () => {
  it('copia campos de catálogo y aplica el descuento efectivo por ítem', () => {
    const carrito = [item({ sku: 'A', itemKey: 'A' }), item({ sku: 'B', itemKey: 'B' })];
    const desc = (it: CarritoItem) => (it.sku === 'A' ? 10 : 0);
    const res = carritoItemsAPresupuestoItems(carrito, desc);
    expect(res.length).toBe(2);
    expect(res[0].sku).toBe('A');
    expect(res[0].descuentoPorcentaje).toBe(10);
    expect(res[0].cantidad).toBe(2);
    expect(res[1].descuentoPorcentaje).toBe(0);
  });

  it('genera uids únicos por índice+sku', () => {
    const carrito = [item({ sku: 'A', itemKey: 'A' }), item({ sku: 'A', itemKey: 'A-2' })];
    const res = carritoItemsAPresupuestoItems(carrito, () => 0);
    expect(res[0].uid).not.toBe(res[1].uid);
  });

  it('preserva generico y comentarios', () => {
    const carrito = [item({ sku: 'G', itemKey: 'G', generico: true, comentarios: 'Mesa a medida' })];
    const res = carritoItemsAPresupuestoItems(carrito, () => 0);
    expect(res[0].generico).toBe(true);
    expect(res[0].comentarios).toBe('Mesa a medida');
  });
});
