/**
 * Helpers compartidos para los QR de los visores (showroom y presupuesto).
 *
 * <p>Ambas pantallas arman la URL del visor de la misma forma
 * ({@code baseUrl}/{segmento}/{username}, con fallback a
 * {@code window.location.origin}) y generan el QR con la misma config. Lo
 * único que cambia es el segmento de ruta (`visor` vs `visor-presupuesto`),
 * así que vive acá para no duplicar la lógica ni la dependencia de `qrcode`.
 *
 * <p>El baseUrl sale de {@code VisorConfig} (config del showroom) — necesario
 * cuando el operador entra por un DNS que los celulares no resuelven; ver la
 * memoria del proyecto sobre IP vs DNS.
 */

/** Arma la URL pública del visor: {@code base/segmento/username}. Vacío en SSR. */
export function construirVisorUrl(
  baseUrl: string | null | undefined,
  username: string,
  segmento: string,
): string {
  if (typeof window === 'undefined') return '';
  const base = baseUrl || window.location.origin;
  return `${base}/${segmento}/${encodeURIComponent(username)}`;
}

/** Genera el dataURL del QR para una URL dada (carga `qrcode` lazy). Devuelve
 *  null si falla o en SSR — el caller muestra la URL como fallback. */
export async function generarQrDataUrl(url: string): Promise<string | null> {
  if (typeof window === 'undefined' || !url) return null;
  try {
    const mod = await import('qrcode');
    const QRCode = (mod as { default?: typeof import('qrcode') }).default ?? mod;
    return await QRCode.toDataURL(url, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 512,
    });
  } catch (err) {
    console.error('No se pudo generar el QR del visor', err);
    return null;
  }
}
