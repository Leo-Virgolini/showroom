/**
 * Abre la pantalla de productos filtrada por un SKU en una pestaña nueva.
 *
 * Usamos `window.open(..., '_blank')` en vez de un `<a target="_blank">` porque
 * la app corre como PWA en modo `fullscreen`/`standalone`: en ese modo un
 * ancla `target="_blank"` abre una VENTANA de la PWA (sin barra de pestañas),
 * mientras que `window.open` delega en el navegador host, que sí abre una
 * pestaña. La pantalla `/productos` lee el query param `q` y filtra por él.
 */
export function abrirCatalogoProducto(sku: string): void {
  if (!sku) return;
  window.open('/productos?q=' + encodeURIComponent(sku), '_blank', 'noopener');
}
