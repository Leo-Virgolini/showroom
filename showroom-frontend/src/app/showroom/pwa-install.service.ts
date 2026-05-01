import { Injectable, signal } from '@angular/core';

/**
 * Type del evento `beforeinstallprompt` — no está en lib.dom.d.ts standard
 * porque es una extensión específica de Chromium (Chrome/Edge). En iOS Safari
 * y Firefox este evento no se dispara: ahí la instalación es manual via
 * "Agregar a pantalla de inicio" y este service queda silencioso.
 */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/**
 * Captura el evento de install prompt del navegador y expone una API simple
 * para que el frontend muestre un botón "Instalar app" cuando está disponible.
 *
 * El evento `beforeinstallprompt` solo se dispara si:
 *  - El SW está registrado y activo (en producción — en dev no se dispara).
 *  - El manifest es válido.
 *  - La app no está ya instalada.
 *  - Se cumplen los heurísticos de engagement del navegador.
 */
@Injectable({ providedIn: 'root' })
export class PwaInstallService {
  readonly disponible = signal(false);
  private deferredPrompt: BeforeInstallPromptEvent | null = null;

  constructor() {
    if (typeof window === 'undefined') return; // SSR safety

    window.addEventListener('beforeinstallprompt', (e: Event) => {
      // Por default Chrome muestra su propio banner; lo cancelamos para que
      // controlemos cuándo aparece desde la UI propia.
      e.preventDefault();
      this.deferredPrompt = e as BeforeInstallPromptEvent;
      this.disponible.set(true);
    });

    window.addEventListener('appinstalled', () => {
      this.deferredPrompt = null;
      this.disponible.set(false);
    });
  }

  async instalar(): Promise<void> {
    if (!this.deferredPrompt) return;
    await this.deferredPrompt.prompt();
    await this.deferredPrompt.userChoice;
    // El prompt es one-shot: una vez disparado no se puede reusar.
    this.deferredPrompt = null;
    this.disponible.set(false);
  }
}
