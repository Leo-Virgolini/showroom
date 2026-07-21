import { parsearFilasImportadas } from './excel-a-items.util';

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
});
