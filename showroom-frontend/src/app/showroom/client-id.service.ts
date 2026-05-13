import { Injectable } from '@angular/core';

/**
 * Identificador único de esta pestaña/PC. Se genera la primera vez que se
 * accede y se persiste en {@code sessionStorage} — sobrevive a navegaciones
 * dentro de la pestaña pero es distinto entre pestañas/ventanas y se borra
 * al cerrar la pestaña.
 *
 * <p>Se manda como header {@code X-Client-Id} en todos los requests al API
 * (via {@code clientIdInterceptor}). El backend lo refleja en los eventos
 * SSE relevantes (ej. {@code pickit-externo}) para que cada PC pueda
 * identificar qué eventos originó ella misma y reaccionar distinto — por
 * ejemplo, solo la PC origen auto-descarga el .xlsx del pickit, las demás
 * solo ven el toast informativo.
 */
@Injectable({ providedIn: 'root' })
export class ClientIdService {
  private static readonly STORAGE_KEY = 'showroom-client-id';
  private cached: string | null = null;

  /** Devuelve el ID de esta pestaña, generándolo si todavía no existe. */
  get(): string {
    if (this.cached) return this.cached;
    if (typeof sessionStorage === 'undefined') {
      // SSR safety: si no hay sessionStorage, generamos uno volátil en memoria.
      this.cached = this.generar();
      return this.cached;
    }
    const guardado = sessionStorage.getItem(ClientIdService.STORAGE_KEY);
    if (guardado) {
      this.cached = guardado;
      return guardado;
    }
    const nuevo = this.generar();
    sessionStorage.setItem(ClientIdService.STORAGE_KEY, nuevo);
    this.cached = nuevo;
    return nuevo;
  }

  /** crypto.randomUUID() requiere contexto seguro (HTTPS o localhost) y está
   *  disponible en todos los browsers modernos. Fallback a Math.random para
   *  contextos no-seguros raros (ej. http://192.168.x.x sin TLS). */
  private generar(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      try {
        return crypto.randomUUID();
      } catch {
        // crypto puede existir pero randomUUID lanzar si el contexto no es seguro.
      }
    }
    return 'cid-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
}
