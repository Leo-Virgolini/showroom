import { mapCantidades, uidADestacar } from './resaltar-item.util';
import type { PresupuestoItem } from './models';

/** Ítem mínimo del detalle para los tests — solo importan uid y cantidad. */
function item(uid: string, cantidad: number): PresupuestoItem {
  return {
    sku: uid,
    descripcion: `PRODUCTO ${uid}`,
    rubro: null,
    pvpKtGastroConIva: 121,
    pvpKtGastroSinIva: 100,
    porcIva: 21,
    stockTotal: 10,
    habilitado: true,
    imagenUrl: null,
    sincronizadoAt: null,
    uid,
    cantidad,
    descuentoPorcentaje: 0,
  };
}

describe('mapCantidades', () => {
  it('mapea uid → cantidad', () => {
    const m = mapCantidades([item('A', 2), item('B', 5)]);
    expect(m.get('A')).toBe(2);
    expect(m.get('B')).toBe(5);
    expect(m.size).toBe(2);
  });

  it('lista vacía → map vacío', () => {
    expect(mapCantidades([]).size).toBe(0);
  });
});

describe('uidADestacar', () => {
  it('un alta nueva devuelve el uid nuevo', () => {
    const prev = mapCantidades([item('A', 1)]);
    expect(uidADestacar(prev, [item('A', 1), item('B', 1)])).toBe('B');
  });

  it('una suma de cantidad devuelve ese uid', () => {
    const prev = mapCantidades([item('A', 1)]);
    expect(uidADestacar(prev, [item('A', 3)])).toBe('A');
  });

  it('primer alta sobre detalle vacío devuelve ese uid', () => {
    expect(uidADestacar(new Map(), [item('A', 1)])).toBe('A');
  });

  it('sin cambios devuelve null', () => {
    const prev = mapCantidades([item('A', 1), item('B', 2)]);
    expect(uidADestacar(prev, [item('A', 1), item('B', 2)])).toBeNull();
  });

  it('dos altas (import) devuelve null', () => {
    expect(uidADestacar(new Map(), [item('A', 1), item('B', 1)])).toBeNull();
  });

  it('dos sumas devuelve null', () => {
    const prev = mapCantidades([item('A', 1), item('B', 1)]);
    expect(uidADestacar(prev, [item('A', 2), item('B', 2)])).toBeNull();
  });

  it('un alta + una suma devuelve null', () => {
    const prev = mapCantidades([item('A', 1)]);
    expect(uidADestacar(prev, [item('A', 2), item('B', 1)])).toBeNull();
  });

  it('un borrado devuelve null', () => {
    const prev = mapCantidades([item('A', 1), item('B', 1)]);
    expect(uidADestacar(prev, [item('A', 1)])).toBeNull();
  });

  it('una baja de cantidad devuelve null', () => {
    const prev = mapCantidades([item('A', 5)]);
    expect(uidADestacar(prev, [item('A', 2)])).toBeNull();
  });

  it('un alta con un borrado simultáneo devuelve el alta', () => {
    const prev = mapCantidades([item('A', 1)]);
    expect(uidADestacar(prev, [item('B', 1)])).toBe('B');
  });

  it('detalle vacío antes y después devuelve null', () => {
    expect(uidADestacar(new Map(), [])).toBeNull();
  });
});
