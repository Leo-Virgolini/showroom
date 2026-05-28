import { DestroyRef, Injectable, effect, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Subject } from 'rxjs';
import { AuthService } from '../auth/auth.service';
import {
  CarritoState,
  Health,
  PickingEmailEvent,
  PickitExternoEvent,
  CotizacionEmailEvent,
  PresupuestoEmailEvent,
  ScanResult,
  ScanVisorError,
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
  /** Resultado del envío del PDF de presupuesto comercial (/presupuestos).
   *  Se dispara al tocar el botón "Enviar por email" en la pantalla. */
  readonly presupuestoEmailEvents$ = new Subject<PresupuestoEmailEvent>();
  /** Resultado del envío del PDF de cotización financiera (/cotizador). */
  readonly cotizacionEmailEvents$ = new Subject<CotizacionEmailEvent>();
  /** Scans publicados al visor (pantalla espejo en celular). El backend
   *  emite uno cada vez que el operador escanea desde la página principal. */
  readonly scanVisorEvents$ = new Subject<ScanResult>();
  /** Notificación al visor cuando un scan no encuentra el producto (404).
   *  El visor lo usa para mostrar un mensaje "código no encontrado" en lugar
   *  de seguir mostrando el último producto válido. */
  readonly scanVisorErrorEvents$ = new Subject<ScanVisorError>();
  /** Estado completo del carrito tras cualquier mutación (operador o visor).
   *  Es el único canal de sincronización del carrito entre pantallas. */
  readonly carritoEvents$ = new Subject<CarritoState>();
  /** Estado de la sesión de atención al cliente. Se emite al iniciar/cancelar/
   *  registrar scan/finalizar. Cuando no hay activa, todos los campos son null. */
  readonly sesionEvents$ = new Subject<SesionShowroom>();
  /** Cambio de estado de un pedido (anulado/reactivado). Lo emite el backend
   *  para que las listas abiertas en /pedidos se refresquen sin polling.
   *  Es global — cualquier operador con la pantalla abierta debe enterarse. */
  readonly pedidoActualizado$ = new Subject<{ pedidoId: number; estado: string }>();
  /** Se emite cuando se detecta que el backend reinició (cambió su bootTimeMs).
   *  Los consumers lo usan para mostrar un toast al operador y/o resetear estado
   *  efímero local que no tenga sentido tras un restart. */
  readonly backendReiniciado$ = new Subject<void>();

  private readonly destroyRef = inject(DestroyRef);
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private source: EventSource | null = null;
  /** Cuando el componente {@code VisorPage} se monta, llama a
   *  {@link conectarComoVisor} con el username del operador (del path) y este
   *  servicio reconfigura el EventSource para enchufarse al canal personal de
   *  ese operador. Null = modo operador (usa /events con la cookie de sesión). */
  private visorUsername: string | null = null;
  private healthPoll: ReturnType<typeof setInterval> | null = null;
  /** Último bootTime visto del backend — comparamos contra el de cada /health
   *  para detectar reinicio. Null hasta el primer health response exitoso. */
  private lastBootTimeMs: number | null = null;
  /** False hasta el primer onopen del SSE. Sirve para distinguir "primera
   *  conexión" (carga inicial de la app) de "reconexión" (donde queremos
   *  rehidratar estado por si nos perdimos eventos durante la caída). */
  private yaConectoAlMenosUnaVez = false;

  /** Último username del operador observado por el effect de auth-change.
   *  Se compara contra {@code auth.currentUser()} para detectar transiciones
   *  login↔logout o cambio de operador en el mismo browser y disparar el
   *  reset del SSE + estado local. Null = nadie autenticado actualmente. */
  private ultimoUsernameAutenticado: string | null = null;

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

    // Observa cambios de sesión del operador. Cuando A logout → B login (o
    // A logout sin login posterior), reconfigura el SSE para que el nuevo
    // operador escuche su propio canal personal en lugar del de A. Sin esto,
    // B vería los toasts/carrito del último canal usado o no recibiría nada.
    //
    // visorUsername (set por VisorPage) tiene prioridad — si la app está
    // corriendo en modo visor (URL /visor/:username), el SSE se mantiene
    // ligado a ese username independientemente del estado de auth.
    effect(() => {
      const u = this.auth.currentUser();
      if (u === undefined) return; // primera resolución de /me, aún no sabemos
      const usernameNuevo = u?.username ?? null;
      if (usernameNuevo === this.ultimoUsernameAutenticado) return;

      const eraReset = this.ultimoUsernameAutenticado !== null;
      this.ultimoUsernameAutenticado = usernameNuevo;

      // En modo visor, el canal lo decide el path — no tocamos el SSE.
      if (this.visorUsername) return;

      // Cambio real de operador (logout, login distinto, login tras logout).
      // Limpiamos estado local efímero para que B no vea datos de A, y
      // reabrimos el SSE para que escuche el canal del usuario nuevo (la
      // cookie de sesión nueva la maneja el browser automáticamente).
      if (eraReset || usernameNuevo) {
        this.resetearEstadoLocal();
        this.cerrarSSE();
        this.yaConectoAlMenosUnaVez = false;
        this.iniciarSSE();
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

    // 2. Sesión activa. Operador: usa /sesion/activa (autenticado). Visor:
    //    usa /visor/{username}/sesion/activa (público) — sin esto el visor
    //    no se enteraría del cliente en curso tras una reconexión.
    const sesionUrl = this.visorUsername
      ? `/api/showroom/visor/${encodeURIComponent(this.visorUsername)}/sesion/activa`
      : '/api/showroom/sesion/activa';
    this.http.get<SesionShowroom>(sesionUrl).subscribe({
      next: (s) => this.sesionEvents$.next(s),
      error: () => { /* silencioso */ },
    });

    // 3. Carrito (autenticado — solo si hay sesión de operador). El visor no
    //    necesita rehidratar el carrito: opera write-only via SSE.
    if (!this.visorUsername && this.auth.currentUser()) {
      this.http.get<CarritoState>('/api/showroom/carrito').subscribe({
        next: (c) => this.carritoEvents$.next(c),
        error: () => { /* silencioso, el interceptor maneja 401 */ },
      });
    }
  }

  /**
   * Reconfigura el SSE para que escuche el canal personal del operador
   * {@code username}. Lo invoca {@code VisorPage} en su constructor con el
   * param del path. Si el SSE ya estaba apuntando al mismo username, es
   * no-op; si apuntaba a otro lugar (operador autenticado o un username
   * distinto) lo cerramos y reabrimos. Idempotente.
   */
  conectarComoVisor(username: string): void {
    if (this.visorUsername === username && this.source) return;
    this.visorUsername = username;
    this.cerrarSSE();
    this.iniciarSSE();
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

    // Si el componente VisorPage nos enchufó al canal de un operador, usamos
    // el endpoint público de ese operador; sino, el endpoint default que
    // toma el username de la sesión HTTP.
    const url = this.visorUsername
      ? `/api/showroom/visor/${encodeURIComponent(this.visorUsername)}/events`
      : '/api/showroom/events';
    const src = new EventSource(url);
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

    src.addEventListener('presupuesto-comercial-email', (e: MessageEvent) => {
      try {
        this.presupuestoEmailEvents$.next(JSON.parse(e.data) as PresupuestoEmailEvent);
      } catch {
        /* payload malformado, ignoramos */
      }
    });

    src.addEventListener('cotizacion-financiera-email', (e: MessageEvent) => {
      try {
        this.cotizacionEmailEvents$.next(JSON.parse(e.data) as CotizacionEmailEvent);
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

    src.addEventListener('scan-visor-error', (e: MessageEvent) => {
      try {
        this.scanVisorErrorEvents$.next(JSON.parse(e.data) as ScanVisorError);
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

    src.addEventListener('pedido-actualizado', (e: MessageEvent) => {
      try {
        this.pedidoActualizado$.next(
          JSON.parse(e.data) as { pedidoId: number; estado: string });
      } catch {
        /* payload malformado, ignoramos */
      }
    });
  }

  private cerrarSSE(): void {
    this.source?.close();
    this.source = null;
  }

  /** Limpia los Subjects de estado per-usuario emitiendo un valor "vacío"
   *  para que cada pantalla suscripta resetee su UI al cambiar el operador.
   *  Sin esto, B veria el carrito y la sesión activa del cliente que A
   *  estaba atendiendo cuando hizo logout. */
  private resetearEstadoLocal(): void {
    // Carrito vacío con origen SISTEMA — equivalente a "no hay carrito".
    this.carritoEvents$.next({ items: [], origen: 'SISTEMA' });
    // Sesión inactiva — el badge "Cliente: X" desaparece de la toolbar.
    this.sesionEvents$.next({
      id: null,
      nombre: null,
      iniciadaAt: null,
      finalizadaAt: null,
      pedidoId: null,
      cantidadEscaneados: 0,
    });
  }
}
