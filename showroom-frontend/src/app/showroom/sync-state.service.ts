import { DestroyRef, Injectable, computed, effect, inject, signal } from '@angular/core';
import { BackendStatusService } from './backend-status.service';
import { ShowroomService } from './showroom.service';
import { Health, SyncEvent } from './models';

/**
 * Estado global del sync de catálogo, propagado vía SSE.
 *
 * Carga inicial: un GET a /health para saber si ya había un sync corriendo
 * cuando el cliente se conecta tarde.
 *
 * Tiempo real: suscripción al stream SSE de /events. Cualquier cliente recibe
 * el evento `sync` cuando otro dispara la sincronización — sin polling.
 *
 * Health card: el badge del toolbar y el banner global comparten esta misma
 * fuente de verdad para que se actualicen en lock-step.
 */
@Injectable({ providedIn: 'root' })
export class SyncStateService {
  private readonly api = inject(ShowroomService);
  private readonly backendStatus = inject(BackendStatusService);
  private readonly destroyRef = inject(DestroyRef);

  readonly health = signal<Health | null>(null);
  /** ISO timestamp del inicio del sync en curso, o null si no hay. */
  readonly syncIniciadoAt = signal<string | null>(null);

  readonly syncEnCurso = computed(() => this.syncIniciadoAt() !== null);

  /** Último evento recibido desde el SSE — útil para que componentes hagan `effect()`. */
  readonly ultimoEvento = signal<SyncEvent | null>(null);

  /** Progreso actual del sync corriendo: items procesados y total esperado. */
  readonly progresoActual = signal<number | null>(null);
  readonly progresoTotal = signal<number | null>(null);

  constructor() {
    this.cargarHealthInicial();
    this.escucharEventos();

    // Cuando el backend (re)conecta — incluyendo el caso "el frontend cargó
    // antes de que el backend estuviera listo" o un drop de SSE — re-consultar
    // /health para captar el estado actual del sync. Sin esto, si el sync
    // ya empezó cuando conectamos tarde, perdemos el evento STARTED y el
    // banner nunca aparece.
    let prev = this.backendStatus.connected();
    effect(() => {
      const ahora = this.backendStatus.connected();
      // Solo en transición false → true (no en cada render con connected=true).
      if (ahora && !prev) {
        this.cargarHealthInicial();
      }
      prev = ahora;
    });
  }

  private cargarHealthInicial(): void {
    this.api.health().subscribe({
      next: (h) => {
        this.health.set(h);
        if (h.syncEnCurso && h.syncIniciadoAt) {
          this.syncIniciadoAt.set(h.syncIniciadoAt);
        } else if (h.syncEnCurso) {
          // Backend dice que está corriendo pero no nos mandó el timestamp.
          // Usamos `now` como aproximación.
          this.syncIniciadoAt.set(new Date().toISOString());
        } else {
          this.syncIniciadoAt.set(null);
        }
      },
      error: () =>
        // bootTimeMs=0 como sentinela "no llegamos al backend" — el listener
        // de BackendStatusService que detecta reinicios solo evalúa el dato
        // que viene del /health real, no de este fallback.
        this.health.set({ bootTimeMs: 0, duxConfigurado: false, syncEnCurso: false, listaPrecios: '—' }),
    });
  }

  private escucharEventos(): void {
    // El EventSource lo abre BackendStatusService. Acá solo nos suscribimos al
    // Subject que ese servicio expone — así no abrimos dos SSE distintas para
    // el mismo endpoint y aprovechamos la misma conexión para detectar
    // caídas de backend a nivel global.
    const sub = this.backendStatus.syncEvents$.subscribe({
      next: (e: SyncEvent) => this.aplicarEvento(e),
    });
    this.destroyRef.onDestroy(() => sub.unsubscribe());
  }

  private aplicarEvento(e: SyncEvent): void {
    this.ultimoEvento.set(e);
    if (e.estado === 'STARTED') {
      this.syncIniciadoAt.set(e.iniciadoAt);
      this.progresoActual.set(null);
      this.progresoTotal.set(null);
      this.patchHealth({ syncEnCurso: true, syncIniciadoAt: e.iniciadoAt });
    } else if (e.estado === 'PROGRESS') {
      this.progresoActual.set(e.items ?? null);
      this.progresoTotal.set(e.total ?? null);
    } else if (e.estado === 'COMPLETED' || e.estado === 'FAILED' || e.estado === 'CANCELLED') {
      this.syncIniciadoAt.set(null);
      this.progresoActual.set(null);
      this.progresoTotal.set(null);
      this.patchHealth({ syncEnCurso: false, syncIniciadoAt: undefined });
      this.cargarHealthInicial();
    }
    // RATE_LIMITED no cambia syncEnCurso ni progreso — el sync sigue activo, solo está esperando.
  }

  private patchHealth(patch: Partial<Health>): void {
    const current = this.health() ?? { bootTimeMs: 0, duxConfigurado: true, syncEnCurso: false, listaPrecios: '—' };
    this.health.set({ ...current, ...patch });
  }

  /** Refresca el health desde el backend (post-disparo manual del sync, etc.). */
  refrescarHealth(): void {
    this.cargarHealthInicial();
  }
}
