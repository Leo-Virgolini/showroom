import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Observable, tap } from 'rxjs';
import { BackendStatusService } from './backend-status.service';
import { SesionShowroom } from './models';
import { ShowroomService } from './showroom.service';

const SESION_INACTIVA: SesionShowroom = {
  id: null,
  nombre: null,
  iniciadaAt: null,
  finalizadaAt: null,
  pedidoId: null,
  cantidadEscaneados: 0,
};

/**
 * Estado y acciones de la SESIÓN DE ATENCIÓN al cliente, COMPARTIDOS entre el
 * showroom y el presupuestador. Hay una sola sesión activa por operador
 * ({@link SesionShowroom}); este servicio la centraliza para que ambas
 * pantallas no dupliquen la hidratación, la suscripción SSE ni las llamadas
 * iniciar/cancelar.
 *
 * <p>Cada pantalla mantiene su PROPIA UI (badge, dialog "Nuevo cliente",
 * toasts) y su pre-llenado del nombre del cliente, porque difieren (el
 * showroom pre-llena un objeto cliente rico y abre el dialog al cargar; el
 * presupuestador solo setea `clienteNombre`). Lo que se unifica es el estado
 * y las acciones, no la presentación.
 */
@Injectable({ providedIn: 'root' })
export class SesionClienteService {
  private readonly api = inject(ShowroomService);
  private readonly backendStatus = inject(BackendStatusService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly _sesion = signal<SesionShowroom>(SESION_INACTIVA);
  /** Sesión activa del operador (o inactiva si no hay). Read-only para los
   *  consumidores; solo el servicio la actualiza. */
  readonly sesion = this._sesion.asReadonly();
  readonly haySesionActiva = computed(() => this._sesion().id != null);

  constructor() {
    // Cambios de sesión en vivo (iniciar/cancelar/registrar scan/finalizar,
    // incluso desde otra pantalla del mismo operador) llegan por SSE. El
    // BackendStatusService también re-emite el estado tras una reconexión.
    this.backendStatus.sesionEvents$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((s) => this._sesion.set(s));
  }

  /** Hidratación inicial: trae la sesión activa del backend, actualiza el
   *  estado y la devuelve para que la pantalla decida su UX de carga (p. ej.
   *  el showroom abre el dialog de "Nuevo cliente" si no hay sesión). */
  hidratar(): Observable<SesionShowroom> {
    return this.api.obtenerSesionActiva().pipe(tap((s) => this._sesion.set(s)));
  }

  /** Inicia una sesión nueva (cierra la anterior del operador del lado backend
   *  y vacía su carrito del showroom). Actualiza el estado al confirmar. */
  iniciar(nombre: string): Observable<SesionShowroom> {
    return this.api.iniciarSesion(nombre).pipe(tap((s) => this._sesion.set(s)));
  }

  /** Finaliza la sesión activa del operador. Actualiza el estado al confirmar. */
  cancelar(): Observable<SesionShowroom> {
    return this.api.cancelarSesion().pipe(tap((s) => this._sesion.set(s)));
  }
}
