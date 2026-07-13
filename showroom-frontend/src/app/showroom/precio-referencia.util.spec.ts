import { precioPorForma, factorConversionUmbral } from './precio-referencia.util';

describe('precioPorForma', () => {
  // conIva = 1000, IVA 21%. baseSinIva ≈ 826,45.
  const conIva = 1000;
  const iva = 21;

  it('Transferencia (recargo 0, con IVA) devuelve el precio lista', () => {
    const r = precioPorForma(conIva, iva, { recargoPorcentaje: 0, aplicaIva: true });
    expect(r).toBeCloseTo(1000, 2);
  });

  it('Efectivo (recargo -13, con IVA) descuenta 13% sobre conIva', () => {
    const r = precioPorForma(conIva, iva, { recargoPorcentaje: -13, aplicaIva: true });
    expect(r).toBeCloseTo(870, 2);
  });

  it('Transferencia S/F (recargo -9, con IVA) descuenta 9% sobre conIva', () => {
    const r = precioPorForma(conIva, iva, { recargoPorcentaje: -9, aplicaIva: true });
    expect(r).toBeCloseTo(910, 2);
  });

  it('recargo positivo (financiación) encarece dividiendo por (1 - r/100)', () => {
    const r = precioPorForma(conIva, iva, { recargoPorcentaje: 28, aplicaIva: true });
    expect(r).toBeCloseTo(1000 / 0.72, 2);
  });

  it('aplicaIva=false devuelve el precio sin IVA', () => {
    const r = precioPorForma(conIva, iva, { recargoPorcentaje: 0, aplicaIva: false });
    expect(r).toBeCloseTo(1000 / 1.21, 2);
  });

  it('conIva null devuelve 0', () => {
    expect(precioPorForma(null, iva, { recargoPorcentaje: -13, aplicaIva: true })).toBe(0);
  });

  it('porcIva null/0 trata el precio como sin IVA gravable', () => {
    const r = precioPorForma(1000, 0, { recargoPorcentaje: -10, aplicaIva: true });
    expect(r).toBeCloseTo(900, 2);
  });

  it('recargo null se trata como 0', () => {
    const r = precioPorForma(conIva, iva, { recargoPorcentaje: null, aplicaIva: true });
    expect(r).toBeCloseTo(1000, 2);
  });
});

describe('factorConversionUmbral', () => {
  // Efectivo = referencia (recargo -13, con IVA). Transferencia = recargo 0, con IVA.
  const efectivo = { recargoPorcentaje: -13, aplicaIva: true };
  const transferencia = { recargoPorcentaje: 0, aplicaIva: true };

  it('mismo aplicaIva: factor = ratio de recargos, independiente del IVA', () => {
    // sel=Transferencia (×1), ref=Efectivo (×0,87) → 1 / 0,87 ≈ 1,149
    const con21 = factorConversionUmbral(transferencia, efectivo, 21);
    const con105 = factorConversionUmbral(transferencia, efectivo, 10.5);
    expect(con21).toBeCloseTo(1 / 0.87, 4);
    expect(con105).toBeCloseTo(1 / 0.87, 4); // NO depende del IVA cuando aplicaIva coincide
  });

  it('sel === ref (mismos parámetros) devuelve 1', () => {
    expect(factorConversionUmbral(efectivo, efectivo, 21)).toBeCloseTo(1, 6);
  });

  it('recargo positivo (financiación) encarece el umbral (> 1)', () => {
    const cuotas = { recargoPorcentaje: 28, aplicaIva: true };
    // sel=cuotas (1/0,72), ref=Efectivo (0,87) → (1/0,72)/0,87
    const f = factorConversionUmbral(cuotas, efectivo, 21);
    expect(f).toBeCloseTo((1 / 0.72) / 0.87, 4);
    expect(f).toBeGreaterThan(1);
  });

  it('aplicaIva distinto: el factor SÍ depende del IVA', () => {
    // sel=Transferencia S/F (recargo -9, SIN IVA), ref=Efectivo (con IVA)
    const transfSF = { recargoPorcentaje: -9, aplicaIva: false };
    const f21 = factorConversionUmbral(transfSF, efectivo, 21);
    const f105 = factorConversionUmbral(transfSF, efectivo, 10.5);
    // sel: (100/1,21)*0,91 ; ref: 100*0,87  → distinto para cada IVA
    expect(f21).toBeCloseTo(((100 / 1.21) * 0.91) / (100 * 0.87), 4);
    expect(f105).not.toBeCloseTo(f21, 4);
  });
});
