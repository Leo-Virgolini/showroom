/**
 * Etiqueta corta de un ítem de carrito/presupuesto para usar en toasts:
 * descripción truncada o el SKU como fallback. Mantiene los avisos legibles
 * sin desbordar. Compartida entre `carrito-editor` (que emite las mutaciones)
 * y `presupuestos-page` (que no la necesita hoy, pero puede reusarla si algún
 * flujo del host vuelve a armar su propio texto de toast).
 */
export function etiquetaItem(it: { descripcion?: string | null; sku: string }): string {
  const desc = (it.descripcion ?? '').trim();
  if (!desc) return it.sku;
  return desc.length > 40 ? `${desc.slice(0, 40)}…` : desc;
}
