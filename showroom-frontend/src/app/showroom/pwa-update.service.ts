import { Injectable, effect, inject, signal } from '@angular/core';
import { SwUpdate } from '@angular/service-worker';
import { BackendStatusService } from './backend-status.service';

/**
 * Avisa cuando el service worker tiene una versión nueva lista y expone una API
 * simple para aplicarla. Espejo de {@link PwaInstallService}: encapsula la API
 * del navegador y expone una señal.
 *
 * Detección del deploy SIN poll: el deploy (Coolify → `docker compose up --build`)
 * reinicia el stack entero, así que la conexión SSE se cae y reconecta. Ese
 * reconnect es la señal de "hubo deploy": cuando `BackendStatusService.connected`
 * pasa de false→true, forzamos `checkForUpdate()`. Angular ya chequea al arrancar,
 * así que el arranque (sin transición desde false) no dispara nada.
 */
@Injectable({ providedIn: 'root' })
export class PwaUpdateService {
  readonly disponible = signal(false);

  private readonly swUpdate = inject(SwUpdate);
  private readonly backendStatus = inject(BackendStatusService);

  constructor() {
    if (typeof window === 'undefined') return; // SSR safety
    // En dev el SW está deshabilitado (provideServiceWorker enabled: !isDevMode).
    // Sin esto, versionUpdates nunca emite y checkForUpdate rechaza — dejamos el
    // servicio inerte para no meter ruido durante desarrollo.
    if (!this.swUpdate.isEnabled) return;

    this.swUpdate.versionUpdates.subscribe((evt) => {
      if (evt.type === 'VERSION_READY') {
        this.disponible.set(true);
      }
    });

    // Disparo por reconnect-SSE. `connected` arranca en true (igual que la señal
    // del BackendStatusService), así que el primer valor no cuenta como
    // reconexión y no duplicamos el chequeo que Angular hace al iniciar.
    let estabaConectado = true;
    effect(() => {
      const conectado = this.backendStatus.connected();
      if (conectado && !estabaConectado) {
        // El backend volvió: probablemente un deploy. Preguntamos si hay versión
        // nueva del frontend. Falla si no hay red → lo ignoramos.
        this.swUpdate.checkForUpdate().catch(() => {});
      }
      estabaConectado = conectado;
    });
  }

  /**
   * Activa la versión nueva del SW y recarga. Si `activateUpdate` falla, recarga
   * igual — el SW se reactiva solo en el próximo arranque.
   */
  async actualizar(): Promise<void> {
    try {
      await this.swUpdate.activateUpdate();
    } catch {
      // Ignorado a propósito: recargamos igual.
    }
    location.reload();
  }
}
