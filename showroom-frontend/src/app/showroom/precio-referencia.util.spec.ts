import { precioPorForma } from './precio-referencia.util';

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
