import { mergearImportados, parsearFilasImportadas } from './excel-a-items.util';
import type { CatalogoItem, PresupuestoItem } from './models';

describe('parsearFilasImportadas', () => {
  it('detecta el encabezado por palabras clave y saltea esa fila', () => {
    const r = parsearFilasImportadas([
      ['SKU', 'Cantidad'],
      ['1051100', 3],
    ]);
    expect(r).toEqual([{ sku: '1051100', cantidad: 3 }]);
  });

  it('reconoce variantes del encabezado (Codigo / Unidades)', () => {
    const r = parsearFilasImportadas([
      ['Codigo', 'Unidades'],
      ['1087654', 2],
    ]);
    expect(r).toEqual([{ sku: '1087654', cantidad: 2 }]);
  });

  it('respeta el orden de columnas del encabezado si viene invertido', () => {
    const r = parsearFilasImportadas([
      ['Cantidad', 'SKU'],
      [5, '1143726'],
    ]);
    expect(r).toEqual([{ sku: '1143726', cantidad: 5 }]);
  });

  it('sin encabezado asume columna A = SKU y columna B = cantidad', () => {
    const r = parsearFilasImportadas([
      ['1051100', 3],
      ['1087654', 2],
    ]);
    expect(r).toEqual([
      { sku: '1051100', cantidad: 3 },
      { sku: '1087654', cantidad: 2 },
    ]);
  });

  it('trata los SKU numéricos de Excel como string', () => {
    const r = parsearFilasImportadas([[1051100, 1]]);
    expect(r).toEqual([{ sku: '1051100', cantidad: 1 }]);
  });

  it('cantidad vacía, no numérica, cero o negativa cae en 1', () => {
    const r = parsearFilasImportadas([
      ['A1', null],
      ['A2', ''],
      ['A3', 'dos'],
      ['A4', 0],
      ['A5', -4],
    ]);
    expect(r).toEqual([
      { sku: 'A1', cantidad: 1 },
      { sku: 'A2', cantidad: 1 },
      { sku: 'A3', cantidad: 1 },
      { sku: 'A4', cantidad: 1 },
      { sku: 'A5', cantidad: 1 },
    ]);
  });

  it('trunca cantidades decimales', () => {
    expect(parsearFilasImportadas([['A1', 2.7]])).toEqual([{ sku: 'A1', cantidad: 2 }]);
  });

  it('cantidad decimal menor a 1 cae en 1, no en 0', () => {
    expect(parsearFilasImportadas([['A1', 0.5]])).toEqual([{ sku: 'A1', cantidad: 1 }]);
  });

  it('acepta decimales con coma (Excel en español)', () => {
    expect(parsearFilasImportadas([['A1', '3,0']])).toEqual([{ sku: 'A1', cantidad: 3 }]);
  });

  it('suma las cantidades de filas con el mismo SKU', () => {
    const r = parsearFilasImportadas([
      ['1051100', 3],
      ['1051100', 2],
    ]);
    expect(r).toEqual([{ sku: '1051100', cantidad: 5 }]);
  });

  it('descarta filas vacías o sin SKU', () => {
    const r = parsearFilasImportadas([
      ['1051100', 1],
      [],
      [null, 5],
      ['   ', 2],
    ]);
    expect(r).toEqual([{ sku: '1051100', cantidad: 1 }]);
  });

  it('devuelve vacío si no hay filas', () => {
    expect(parsearFilasImportadas([])).toEqual([]);
  });

  it('con encabezado pero sin filas de datos devuelve vacío', () => {
    expect(parsearFilasImportadas([['SKU', 'Cantidad']])).toEqual([]);
  });

  it('con encabezado parcial usa la posición detectada, no el default', () => {
    const r = parsearFilasImportadas([
      ['Cantidad', 'Producto'],
      [4, '1051100'],
    ]);
    expect(r).toEqual([{ sku: '1051100', cantidad: 4 }]);
  });

  it('encabezado solo de SKU deja la cantidad en la columna por defecto', () => {
    const r = parsearFilasImportadas([
      ['SKU', 'Bultos'],
      ['1051100', 6],
    ]);
    expect(r).toEqual([{ sku: '1051100', cantidad: 6 }]);
  });
});

describe('mergearImportados', () => {
  const uid = (sku: string) => `uid-${sku}`;

  const catalogo = (sku: string): CatalogoItem => ({
    sku,
    descripcion: `PRODUCTO ${sku}`,
    rubro: null,
    pvpKtGastroSinIva: 100,
    pvpKtGastroConIva: 121,
    porcIva: 21,
    habilitado: true,
    imagenUrl: null,
    stockTotal: 10,
  });

  const enDetalle = (sku: string, cantidad: number): PresupuestoItem => ({
    sku,
    descripcion: `PRODUCTO ${sku}`,
    rubro: null,
    pvpKtGastroConIva: 121,
    pvpKtGastroSinIva: 100,
    porcIva: 21,
    stockTotal: 10,
    habilitado: true,
    imagenUrl: null,
    sincronizadoAt: null,
    uid: `viejo-${sku}`,
    cantidad,
    descuentoPorcentaje: 0,
  });

  it('agrega los SKU que no estaban en el detalle', () => {
    const r = mergearImportados([], [{ sku: 'A1', cantidad: 3 }], [catalogo('A1')], uid);
    expect(r.items).toHaveLength(1);
    expect(r.items[0].sku).toBe('A1');
    expect(r.items[0].cantidad).toBe(3);
    expect(r.items[0].uid).toBe('uid-A1');
    expect(r.agregados).toBe(1);
    expect(r.actualizados).toBe(0);
  });

  it('suma la cantidad si el SKU ya estaba en el detalle', () => {
    const r = mergearImportados(
      [enDetalle('A1', 2)],
      [{ sku: 'A1', cantidad: 3 }],
      [catalogo('A1')],
      uid,
    );
    expect(r.items).toHaveLength(1);
    expect(r.items[0].cantidad).toBe(5);
    expect(r.items[0].uid).toBe('viejo-A1');
    expect(r.agregados).toBe(0);
    expect(r.actualizados).toBe(1);
  });

  it('conserva el descuento del ítem que ya estaba', () => {
    const existente = { ...enDetalle('A1', 2), descuentoPorcentaje: 15 };
    const r = mergearImportados([existente], [{ sku: 'A1', cantidad: 1 }], [catalogo('A1')], uid);
    expect(r.items[0].descuentoPorcentaje).toBe(15);
  });

  it('reporta los SKU que no están en el catálogo y no los agrega', () => {
    const r = mergearImportados(
      [],
      [{ sku: 'A1', cantidad: 1 }, { sku: 'FANTASMA', cantidad: 2 }],
      [catalogo('A1')],
      uid,
    );
    expect(r.items).toHaveLength(1);
    expect(r.noEncontrados).toEqual(['FANTASMA']);
    expect(r.agregados).toBe(1);
  });

  it('no muta el array de items original', () => {
    const actuales = [enDetalle('A1', 2)];
    mergearImportados(actuales, [{ sku: 'A1', cantidad: 3 }], [catalogo('A1')], uid);
    expect(actuales[0].cantidad).toBe(2);
  });

  it('los ítems nuevos nacen con descuento 0 y sincronizadoAt null', () => {
    const r = mergearImportados([], [{ sku: 'A1', cantidad: 1 }], [catalogo('A1')], uid);
    expect(r.items[0].descuentoPorcentaje).toBe(0);
    expect(r.items[0].sincronizadoAt).toBeNull();
  });

  it('conserva el orden: primero lo que ya estaba, después lo importado', () => {
    const r = mergearImportados(
      [enDetalle('VIEJO', 1)],
      [{ sku: 'NUEVO', cantidad: 1 }],
      [catalogo('NUEVO')],
      uid,
    );
    expect(r.items.map((i: PresupuestoItem) => i.sku)).toEqual(['VIEJO', 'NUEVO']);
  });

  it('sin filas devuelve el detalle intacto', () => {
    const actuales = [enDetalle('A1', 2)];
    const r = mergearImportados(actuales, [], [], uid);
    expect(r.items).toEqual(actuales);
    expect(r.agregados).toBe(0);
    expect(r.noEncontrados).toEqual([]);
  });
});
