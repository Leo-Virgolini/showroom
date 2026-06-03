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
 * Fórmula (coincide con el cálculo del carrito):
 *   baseSinIva = conIva / (1 + iva/100)
 *   recargo > 0 → baseSinIva / (1 - r/100)        (encarece: financiación)
 *   recargo = 0 → baseSinIva
 *   recargo < 0 → baseSinIva * (1 - |r|/100)       (descuenta: contado)
 *   resultado   = aplicaIva ? ajustado * (1 + iva/100) : ajustado
 *
 * El backend del pedido ignora los recargos ≤ 0, así que un descuento acá solo
 * afecta el precio MOSTRADO, no lo que se factura en DUX (decisión del negocio).
 */
export function precioPorForma(
  conIva: number | null,
  porcIva: number | null,
  forma: FormaPagoCalc,
): number {
  if (conIva == null) return 0;
  const iva = porcIva ?? 0;
  const baseSinIva = iva > 0 ? conIva / (1 + iva / 100) : conIva;
  const r = forma.recargoPorcentaje ?? 0;
  let ajustadoSinIva: number;
  if (r > 0) {
    ajustadoSinIva = baseSinIva / (1 - r / 100);
  } else if (r < 0) {
    ajustadoSinIva = baseSinIva * (1 - Math.abs(r) / 100);
  } else {
    ajustadoSinIva = baseSinIva;
  }
  const aplicaIva = forma.aplicaIva ?? true;
  return aplicaIva && iva > 0 ? ajustadoSinIva * (1 + iva / 100) : ajustadoSinIva;
}

/**
 * Ícono PrimeNG sugerido para una forma de pago, inferido de su nombre.
 * Heurística simple para acompañar los precios de referencia en scan/visor.
 * Cae a `pi-tag` para nombres no reconocidos.
 */
export function iconoFormaReferencia(nombre: string | null | undefined): string {
  const n = (nombre ?? '').toLowerCase();
  if (n.includes('efectivo') || n.includes('contado')) return 'pi pi-money-bill';
  if (n.includes('transfer')) return 'pi pi-building';
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
