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

/** Resultado de {@link abrirPdfEnPreview}. */
export interface ResultadoPdfPreview {
  /** Nombre del archivo resuelto del Content-Disposition (o el fallback). */
  filename: string;
  /** Si efectivamente se cargó el PDF en la pestaña preview. False si el
   *  popup-blocker bloqueó la apertura — en ese caso se hizo descarga a
   *  disco como fallback para que el usuario igual reciba el PDF. */
  previewAbierto: boolean;
}

/**
 * Carga un PDF recibido del backend en la pestaña preview ya abierta
 * (típicamente con {@code window.open('about:blank', '_blank')} sincrónico
 * con el click, para evitar el popup-blocker). NO auto-descarga cuando el
 * preview se abrió: si el usuario quiere bajar el archivo, lo hace desde el
 * visor del browser. El nombre del archivo persistido viene del header
 * Content-Disposition para que la descarga manual respete ese nombre.
 *
 * <p>Si la pestaña fue bloqueada por el popup-blocker (previewTab null o
 * cerrada), cae a auto-download — sino el usuario no recibiría nada. El
 * resultado incluye {@code previewAbierto} para que el caller pueda
 * adaptar el toast (preview vs descarga forzada).
 *
 * <p>El object URL se libera 60s después — el visor necesita el URL para
 * renderizar; si lo revocamos antes, muestra "página no encontrada". A los
 * 60s el contenido ya quedó cargado en la pestaña.
 *
 * @return el resultado con filename + flag de preview abierto; null si el
 *         backend no devolvió cuerpo de PDF.
 */
export function abrirPdfEnPreview(
  resp: HttpResponse<Blob>,
  fallbackName: string,
  previewTab: Window | null,
): ResultadoPdfPreview | null {
  const blob = resp.body;
  if (!blob) {
    if (previewTab) previewTab.close();
    return null;
  }
  const filename = parsearFilenameDisposition(resp.headers.get('Content-Disposition'))
    ?? fallbackName;
  const popupBloqueado = previewTab == null || previewTab.closed;
  if (popupBloqueado) {
    // Fallback: el browser bloqueó la pestaña. Bajamos el PDF a disco como
    // plan B para que el operador igual reciba el archivo. El toast del
    // caller le aclara que no se abrió el visor (con `previewAbierto=false`).
    dispararDescargaBlob(resp, fallbackName);
    return { filename, previewAbierto: false };
  }
  const url = URL.createObjectURL(blob);
  previewTab.location.href = url;
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return { filename, previewAbierto: true };
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
