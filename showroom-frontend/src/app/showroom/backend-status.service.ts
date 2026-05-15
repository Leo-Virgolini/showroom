import { DestroyRef, Injectable, effect, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Subject } from 'rxjs';
import { AuthService } from '../auth/auth.service';
import {
  CarritoState,
  Health,
  PickingEmailEvent,
  PickitExternoEvent,
  ScanResult,
  SesionShowroom,
  SyncEvent,
  WhatsappBusinessEvent,
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
  /** Resultado del envío del PDF por WhatsApp tras un pedido. SENT / FAILED /
   *  WINDOW_CLOSED (este último cuando el cliente no escribió en 24hs). */
  readonly whatsappBusinessEvents$ = new Subject<WhatsappBusinessEvent>();
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
  /** Se emite cuando se detecta que el backend reinició (cambió su bootTimeMs).
   *  Los consumers lo usan para mostrar un toast al operador y/o resetear estado
   *  efímero local que no tenga sentido tras un restart. */
  readonly backendReiniciado$ = new Subject<void>();

  private readonly destroyRef = inject(DestroyRef);
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private source: EventSource | null = null;
  private healthPoll: ReturnType<typeof setInterval> | null = null;
  /** Último bootTime visto del backend — comparamos contra el de cada /health
   *  para detectar reinicio. Null hasta el primer health response exitoso. */
  private lastBootTimeMs: number | null = null;
  /** False hasta el primer onopen del SSE. Sirve para distinguir "primera
   *  conexión" (carga inicial de la app) de "reconexión" (donde queremos
   *  rehidratar estado por si nos perdimos eventos durante la caída). */
  private yaConectoAlMenosUnaVez = false;

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

  /**
   * Establece el {@code lastBootTimeMs} la primera vez que conectamos al
   * backend. Sirve de baseline para detectar reinicios en {@link rehidratarEstado}.
   * Si el fetch falla (network/timeout), lo intentamos de nuevo en la próxima
   * reconexión — no es crítico.
   */
  private fetchBootTimeBaseline(): void {
    this.http.get<Health>('/api/showroom/health').subscribe({
      next: (h) => { if (h.bootTimeMs != null) this.lastBootTimeMs = h.bootTimeMs; },
      error: () => { /* silencioso, se reintenta en la próxima reconexión */ },
    });
  }

  /**
   * Tras una reconexión SSE, re-sincroniza el estado in-memory del backend
   * (sesión activa + carrito) y detecta si el backend reinició mientras
   * estábamos desconectados.
   *
   * <p>Estrategia: emitir los estados frescos por los Subjects existentes
   * ({@code sesionEvents$}, {@code carritoEvents$}) — los listeners actuales
   * de cada página se actualizan transparentemente, sin lógica especial de
   * "este evento vino de un resync vs. de un SSE real".
   *
   * <p>El carrito solo se pide si hay usuario autenticado: en visor anónimo
   * el endpoint devuelve 401 y el interceptor lo trata como ruido.
   */
  private rehidratarEstado(): void {
    // 1. Health: bootTime nos dice si el backend reinició → notificamos para
    //    que el frontend muestre toast y limpie estado fantasma.
    this.http.get<Health>('/api/showroom/health').subscribe({
      next: (h) => {
        if (h.bootTimeMs == null) return;
        if (this.lastBootTimeMs != null && h.bootTimeMs !== this.lastBootTimeMs) {
          this.backendReiniciado$.next();
        }
        this.lastBootTimeMs = h.bootTimeMs;
      },
      error: () => { /* silencioso */ },
    });

    // 2. Sesión activa (público — sirve para operador y visor).
    this.http.get<SesionShowroom>('/api/showroom/sesion/activa').subscribe({
      next: (s) => this.sesionEvents$.next(s),
      error: () => { /* silencioso */ },
    });

    // 3. Carrito (autenticado — solo si hay sesión de operador).
    if (this.auth.currentUser()) {
      this.http.get<CarritoState>('/api/showroom/carrito').subscribe({
        next: (c) => this.carritoEvents$.next(c),
        error: () => { /* silencioso, el interceptor maneja 401 */ },
      });
    }
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
      const esReconexion = this.yaConectoAlMenosUnaVez;
      this.yaConectoAlMenosUnaVez = true;
      this.markConnected();
      if (esReconexion) {
        // Reconexión tras una caída: nos podemos haber perdido eventos del
        // carrito/sesión mientras estuvimos offline. Re-fetcheamos el estado
        // actual y lo emitimos por los Subjects existentes para que cada
        // consumer (operador, visor) se actualice sin lógica especial.
        this.rehidratarEstado();
      } else {
        // Primera conexión: solo establecemos el baseline del bootTime para
        // poder detectar reinicios futuros. Las páginas hacen su propio fetch
        // inicial — no necesitamos disparar Subjects acá.
        this.fetchBootTimeBaseline();
      }
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

    src.addEventListener('whatsapp-business', (e: MessageEvent) => {
      try {
        this.whatsappBusinessEvents$.next(JSON.parse(e.data) as WhatsappBusinessEvent);
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
