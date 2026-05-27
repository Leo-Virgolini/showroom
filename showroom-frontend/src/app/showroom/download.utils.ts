import { HttpResponse } from '@angular/common/http';

/**
 * Dispara la descarga de un blob (típicamente un PDF) usando un `<a download>`
 * efímero. El nombre del archivo sale del header `Content-Disposition` de la
 * respuesta; si no viene, usa `fallbackName`.
 *
 * <p>Centraliza el patrón que antes estaba duplicado en varias páginas
 * (pedidos, historial) — todas las descargas autenticadas vía `HttpClient`
 * con `responseType:'blob'` deberían usar esta función.
 */
export function dispararDescargaBlob(resp: HttpResponse<Blob>, fallbackName: string): void {
  const blob = resp.body;
  if (!blob) return;
  const filename = parsearFilenameDisposition(resp.headers.get('Content-Disposition')) ?? fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * Extrae el filename de un header `Content-Disposition`. Soporta las tres
 * variantes: `filename="x.pdf"`, `filename=x.pdf` y `filename*=UTF-8''x.pdf`.
 * Devuelve null si no hay header o no matchea.
 */
export function parsearFilenameDisposition(contentDisposition: string | null): string | null {
  if (!contentDisposition) return null;
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(contentDisposition);
  if (utf8?.[1]) return decodeURIComponent(utf8[1].trim());
  const ascii = /filename="?([^";]+)"?/i.exec(contentDisposition);
  return ascii?.[1]?.trim() ?? null;
}
