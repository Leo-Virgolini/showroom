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
 * Los dos perfiles (menaje + maquinaria) de una forma de pago. Subconjunto de
 * `FormaPago` con lo que necesita {@link perfilForma} para elegir el perfil.
 */
export interface FormaPagoPerfiles {
  recargoPorcentaje: number | null;
  aplicaIva: boolean | null;
  recargoPorcentajeMaquinaria: number | null;
  aplicaIvaMaquinaria: boolean | null;
}

/**
 * Recargo + aplicaIva del perfil (menaje o maquinaria) de una forma, según el
 * rubro del producto. Maquinaria usa sus propios campos: recargo null → 0 (NO
 * hereda del menaje); aplicaIva null → false. Menaje: recargoPorcentaje /
 * aplicaIva tal cual. Es la fórmula única reusada por scan/visor/carrito,
 * presupuestos, cotizador e historial.
 */
export function perfilForma(forma: FormaPagoPerfiles, esMaquinaria: boolean): FormaPagoCalc {
  if (esMaquinaria) {
    return {
      recargoPorcentaje: forma.recargoPorcentajeMaquinaria ?? 0,
      aplicaIva: forma.aplicaIvaMaquinaria ?? false,
    };
  }
  return { recargoPorcentaje: forma.recargoPorcentaje, aplicaIva: forma.aplicaIva };
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
 * Redondeo a 2 decimales (HALF_UP-ish) para montos. Alinea el preview en
 * pantalla con el `BigDecimal.setScale(2, HALF_UP)` que aplica el backend al
 * generar PDFs, evitando discrepancias de centavos.
 */
export function redondearMoneda(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Quita el IVA de un precio con IVA. Si `precioConIva` es null → null; si
 * `porcIva` es null o 0 → el precio tal cual; en otro caso
 * `precioConIva / (1 + porcIva/100)`.
 */
export function precioSinIva(
  precioConIva: number | null,
  porcIva: number | null,
): number | null {
  if (precioConIva == null) return null;
  if (porcIva == null || porcIva === 0) return precioConIva;
  return precioConIva / (1 + porcIva / 100);
}

/**
 * Índice de la forma de pago más barata de una lista, o -1 si no hay una
 * ganadora clara. Ignora las formas en moneda extranjera (`monedaSimbolo`
 * presente) y las que no tienen un `precioFinal` positivo. Devuelve -1 si la
 * lista tiene 0/1 elementos, si no hay candidata válida, o si hay empate en el
 * precio mínimo.
 */
export function calcularIndiceMejorPrecio(
  formas: ReadonlyArray<{ precioFinal: number | null; monedaSimbolo?: string | null }>,
): number {
  if (formas.length <= 1) return -1;
  let idx = -1;
  let min: number | null = null;
  formas.forEach((f, i) => {
    if (f.precioFinal == null || f.precioFinal <= 0) return;
    if (f.monedaSimbolo) return;
    if (min == null || f.precioFinal < min) {
      min = f.precioFinal;
      idx = i;
    }
  });
  if (idx === -1 || min == null) return -1;
  const empates = formas.filter(
    (f) => f.precioFinal === min && !f.monedaSimbolo,
  ).length;
  return empates > 1 ? -1 : idx;
}

/**
 * Escalas de descuento ordenadas asc por `umbralMin` (copia — no muta el array
 * recibido). Orden natural para mostrar "comprá más y ahorrás".
 */
export function ordenarEscalasPorUmbral<T extends { umbralMin: number }>(
  escalas: readonly T[],
): T[] {
  return [...escalas].sort((a, b) => a.umbralMin - b.umbralMin);
}

/**
 * True si existe un escalón con umbral mayor que `escala` que el `precio` ya
 * alcanza (hay un descuento mejor disponible). Usado para atenuar tiles de
 * escalones inferiores cuando otro mejor ya aplica.
 */
export function hayEscalonSuperior(
  precio: number,
  escala: { umbralMin: number },
  escalas: ReadonlyArray<{ umbralMin: number }>,
): boolean {
  return escalas.some((e) => e.umbralMin > escala.umbralMin && precio >= e.umbralMin);
}

/**
 * Ícono PrimeNG sugerido para una forma de pago, inferido de su nombre.
 * Heurística simple para acompañar los precios de referencia en scan/visor.
 * Cae a `pi-tag` para nombres no reconocidos.
 */
export function iconoFormaReferencia(nombre: string | null | undefined): string {
  const n = (nombre ?? '').toLowerCase();
  if (n.includes('efectivo') || n.includes('contado')) return 'pi pi-money-bill';
  if (n.includes('dólar') || n.includes('dolar') || n.includes('usd')) return 'pi pi-dollar';
  if (n.includes('transfer') || n.includes('depósito') || n.includes('deposito')) {
    return 'pi pi-arrow-right-arrow-left';
  }
  if (n.includes('cheque')) return 'pi pi-receipt';
  if (n.includes('mercado')) return 'pi pi-shopping-cart';
  if (
    n.includes('tarjeta') ||
    n.includes('crédito') || n.includes('credito') ||
    n.includes('débito') || n.includes('debito') ||
    n.includes('cuota')
  ) {
    return 'pi pi-credit-card';
  }
  if (n.includes('remito')) return 'pi pi-file';
  return 'pi pi-tag';
}

/**
 * Factor multiplicativo para expresar un monto medido en la forma de REFERENCIA
 * (ej. Efectivo) en unidades de la forma SELECCIONADA. Uso: convertir el umbral
 * del descuento por monto a la forma de pago que ve el cliente. Es display-only:
 * NO cambia la comparación del descuento.
 *
 *   factor = precioPorForma(100, ivaRef, formaSel) / precioPorForma(100, ivaRef, formaRef)
 *
 * - Si ambas formas comparten `aplicaIva`, el `ivaRef` se cancela → factor exacto
 *   e independiente del IVA (caso normal: Efectivo ↔ Transferencia, Cuotas).
 * - Si difieren en `aplicaIva` (ej. Transferencia S/F sin IVA), el factor depende
 *   del `ivaRef` (usar el IVA real del producto, o 21 dominante en el agregado).
 * - Si el precio de referencia es 0 (no debería), devuelve 1 (sin conversión).
 *
 * Ambas formas deben venir ya en el perfil correcto (menaje) vía `perfilForma`.
 */
export function factorConversionUmbral(
  formaSel: FormaPagoCalc,
  formaRef: FormaPagoCalc,
  ivaRef: number,
): number {
  const ref = precioPorForma(100, ivaRef, formaRef);
  if (ref <= 0) return 1;
  return precioPorForma(100, ivaRef, formaSel) / ref;
}
