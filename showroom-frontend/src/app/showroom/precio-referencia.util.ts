/**
 * Datos mínimos de una forma de pago necesarios para calcular su precio de
 * display. Subconjunto de {@link FormaPago} — se acepta este shape acotado para
 * poder testear la función sin construir una forma completa.
 */
export interface FormaPagoCalc {
  recargoPorcentaje: number | null;
  aplicaIva: boolean | null;
}

/**
 * Precio unitario que paga el cliente con una forma de pago dada, calculado
 * sobre el PVP gastro CON IVA del producto.
 *
 * El recargo se traduce a un factor:
 *   recargo > 0 → 1 / (1 - r/100)   (encarece: financiación)
 *   recargo = 0 → 1
 *   recargo < 0 → 1 - |r|/100        (descuenta: contado — ej. -13 → ×0,87)
 *
 * - Forma CON IVA: el factor se aplica directo sobre el precio con IVA, así que
 *   un -13% da exactamente `conIva × 0,87`.
 * - Forma SIN IVA: primero se quita el IVA (el cliente paga sin IVA) y el factor
 *   se aplica sobre el neto.
 *
 * El backend del pedido usa la misma lógica (recargos negativos = descuento), así
 * que lo que se factura en DUX coincide con este precio mostrado.
 */
export function precioPorForma(
  conIva: number | null,
  porcIva: number | null,
  forma: FormaPagoCalc,
): number {
  if (conIva == null) return 0;
  const r = forma.recargoPorcentaje ?? 0;
  const factor = r > 0 ? 1 / (1 - r / 100) : r < 0 ? 1 - Math.abs(r) / 100 : 1;
  const iva = porcIva ?? 0;
  const aplicaIva = forma.aplicaIva ?? true;
  // Con IVA: factor sobre el precio con IVA. Sin IVA: se quita el IVA primero.
  const base = aplicaIva ? conIva : conIva / (1 + iva / 100);
  return base * factor;
}

/**
 * Ícono PrimeNG sugerido para una forma de pago, inferido de su nombre.
 * Heurística simple para acompañar los precios de referencia en scan/visor.
 * Cae a `pi-tag` para nombres no reconocidos.
 */
export function iconoFormaReferencia(nombre: string | null | undefined): string {
  const n = (nombre ?? '').toLowerCase();
  if (n.includes('efectivo') || n.includes('contado')) return 'pi pi-money-bill';
  if (n.includes('transfer')) return 'pi pi-arrow-right-arrow-left';
  if (
    n.includes('tarjeta') ||
    n.includes('crédito') || n.includes('credito') ||
    n.includes('débito') || n.includes('debito') ||
    n.includes('cuota')
  ) {
    return 'pi pi-credit-card';
  }
  return 'pi pi-tag';
}
