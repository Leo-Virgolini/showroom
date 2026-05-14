import { DestroyRef, Injectable, effect, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Subject } from 'rxjs';
import {
  CarritoState,
  PickingEmailEvent,
  PickitExternoEvent,
  ScanResult,
  SesionShowroom,
  SyncEvent,
} from './models';

/**
 * Estado de conectividad con el backend.
 *
 * Detección normal: UN EventSource hacia `/api/showroom/events`.
 *  - `onopen` → SSE abrió (o reabrió tras un drop) → conectado.
 *  - `onerror` → SSE cortado. El navegador reintenta solo en background; cuando
 *    lo logra, dispara `onopen` y volvemos a conectado.
 *
 * Fallback: si el EventSource queda en estado CLOSED (puede pasar si el dev
 * proxy responde 502 mientras el back arranca, o si el back devolvió un
 * response sin Content-Type SSE), el navegador NO reintenta más — el modal
 * quedaría pegado. Para cubrir ese caso, mientras `connected === false`,
 * polleamos `/api/showroom/health` cada 10s. Cuando responde, el interceptor
 * marca conectado y reabrimos el SSE si quedó cerrado.
 *
 * Detección instant: el HTTP interceptor marca desconectado en cuanto un
 * request HTTP falla con status 0, sin esperar al timeout del SSE.
 *
 * Recuperación rápida en mobile: cuando la pestaña vuelve del background
 * (visibilitychange) o el dispositivo recupera red (online event), forzamos
 * un health-ping inmediato + reconexión del SSE si quedó cerrado, en lugar
 * de esperar el siguiente tick del poll de 10s.
 */
@Injectable({ providedIn: 'root' })
export class BackendStatusService {
  readonly connected = signal(true);
  readonly syncEvents$ = new Subject<SyncEvent>();
  readonly pickingEmailEvents$ = new Subject<PickingEmailEvent>();
  /** Resultado de la generación del pickit externo (programa pickit-y-etiquetas).
   *  Se dispara tras DUX OK (automático) o cuando el operador toca el botón
   *  manual desde /pedidos. */
  readonly pickitExternoEvents$ = new Subject<PickitExternoEvent>();
  /** Scans publicados al visor (pantalla espejo en celular). El backend
   *  emite uno cada vez que el operador escanea desde la página principal. */
  readonly scanVisorEvents$ = new Subject<ScanResult>();
  /** Estado completo del carrito tras cualquier mutación (operador o visor).
   *  Es el único canal de sincronización del carrito entre pantallas. */
  readonly carritoEvents$ = new Subject<CarritoState>();
  /** Estado de la sesión de atención al cliente. Se emite al iniciar/cancelar/
   *  registrar scan/finalizar. Cuando no hay activa, todos los campos son null. */
  readonly sesionEvents$ = new Subject<SesionShowroom>();

  private readonly destroyRef = inject(DestroyRef);
  private readonly http = inject(HttpClient);
  private source: EventSource | null = null;
  private healthPoll: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.iniciarSSE();

    effect(() => {
      const isConnected = this.connected();
      if (!isConnected && this.healthPoll == null) {
        this.healthPoll = setInterval(() => this.pingHealth(), 10_000);
      } else if (isConnected && this.healthPoll != null) {
        clearInterval(this.healthPoll);
        this.healthPoll = null;
        if (this.source && this.source.readyState === EventSource.CLOSED) {
          this.cerrarSSE();
          this.iniciarSSE();
        }
      }
    });

    // Recuperación rápida cuando la pestaña vuelve del background (mobile)
    // o vuelve la red. Sin esto, hay que esperar hasta 10s al siguiente
    // health-ping para que el modal "Sin conexión" se cierre.
    if (typeof document !== 'undefined') {
      const onVisible = () => {
        if (document.visibilityState === 'visible') this.recuperarConexion();
      };
      document.addEventListener('visibilitychange', onVisible);
      this.destroyRef.onDestroy(() =>
        document.removeEventListener('visibilitychange', onVisible),
      );
    }
    if (typeof window !== 'undefined') {
      const onOnline = () => this.recuperarConexion();
      window.addEventListener('online', onOnline);
      this.destroyRef.onDestroy(() =>
        window.removeEventListener('online', onOnline),
      );
    }

    this.destroyRef.onDestroy(() => {
      this.cerrarSSE();
      if (this.healthPoll != null) clearInterval(this.healthPoll);
    });
  }

  /**
   * Forzá un health-ping inmediato y reconectá el SSE si quedó cerrado.
   * Idempotente: si la conexión ya está sana, el ping responde 200 y no
   * pasa nada. Lo llamamos cuando la pestaña vuelve del background o el
   * dispositivo recupera red — eventos donde lo más probable es que el
   * SSE haya quedado muerto silenciosamente y no querríamos esperar al
   * siguiente tick del poll de 10s para enterarnos.
   */
  private recuperarConexion(): void {
    this.pingHealth();
    if (this.source && this.source.readyState === EventSource.CLOSED) {
      this.cerrarSSE();
      this.iniciarSSE();
    }
  }

  private pingHealth(): void {
    this.http.get('/api/showroom/health').subscribe({
      error: () => {
        /* el interceptor ya marcó desconectado; seguimos polleando */
      },
    });
  }

  markDisconnected(): void {
    if (this.connected()) this.connected.set(false);
  }

  markConnected(): void {
    if (!this.connected()) this.connected.set(true);
  }

  private iniciarSSE(): void {
    if (typeof window === 'undefined') return; // SSR safety
    if (this.source) return;

    const src = new EventSource('/api/showroom/events');
    this.source = src;

    src.onopen = () => {
      // El handshake SSE terminó OK — backend respondiendo.
      this.markConnected();
    };

    src.onerror = () => {
      // El navegador dispara error cuando la conexión se cae. EventSource hace
      // reconnect automático en background — cuando lo logra, va a disparar
      // onopen de nuevo y vamos a marcar conectado.
      // Mientras readyState !== OPEN, lo consideramos desconectado.
      if (src.readyState !== EventSource.OPEN) {
        this.markDisconnected();
      }
    };

    src.addEventListener('sync', (e: MessageEvent) => {
      try {
        this.syncEvents$.next(JSON.parse(e.data) as SyncEvent);
      } catch {
        /* payload malformado, ignoramos */
      }
    });

    src.addEventListener('picking-email', (e: MessageEvent) => {
      try {
        this.pickingEmailEvents$.next(JSON.parse(e.data) as PickingEmailEvent);
      } catch {
        /* payload malformado, ignoramos */
      }
    });

    src.addEventListener('pickit-externo', (e: MessageEvent) => {
      try {
        this.pickitExternoEvents$.next(JSON.parse(e.data) as PickitExternoEvent);
      } catch {
        /* payload malformado, ignoramos */
      }
    });

    src.addEventListener('scan-visor', (e: MessageEvent) => {
      try {
        this.scanVisorEvents$.next(JSON.parse(e.data) as ScanResult);
      } catch {
        /* payload malformado, ignoramos */
      }
    });

    src.addEventListener('carrito-updated', (e: MessageEvent) => {
      try {
        this.carritoEvents$.next(JSON.parse(e.data) as CarritoState);
      } catch {
        /* payload malformado, ignoramos */
      }
    });

    src.addEventListener('sesion-updated', (e: MessageEvent) => {
      try {
        this.sesionEvents$.next(JSON.parse(e.data) as SesionShowroom);
      } catch {
        /* payload malformado, ignoramos */
      }
    });
  }

  private cerrarSSE(): void {
    this.source?.close();
    this.source = null;
  }
}
