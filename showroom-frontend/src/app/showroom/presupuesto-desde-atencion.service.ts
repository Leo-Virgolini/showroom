import { Injectable, signal } from '@angular/core';
import { PresupuestoItem } from './models';

/** Borrador transitorio que viaja del showroom al presupuestador cuando el
 *  operador elige "Crear presupuesto" desde una atención. */
export interface BorradorPresupuestoAtencion {
  items: PresupuestoItem[];
  clienteNombre: string | null;
  formaPagoSeleccionadaId: number | null;
  /** Id de la sesión de atención de origen. Viaja al backend como
   *  `origenAtencionSesionId`: al guardar el presupuesto, el backend cierra
   *  esa sesión SOLO SI todavía es la sesión activa del operador (si en otra
   *  pestaña ya arrancó otra atención, no se toca nada). */
  sesionId: number | null;
}

/**
 * Puente en memoria showroom → presupuestador. El showroom deja un borrador y
 * navega a `/presupuestos`; el presupuestador lo consume UNA vez al iniciar.
 * Estado volátil a propósito: si el operador recarga la pestaña se pierde el
 * borrador (el carrito sigue vivo en el backend, puede reintentar).
 */
@Injectable({ providedIn: 'root' })
export class PresupuestoDesdeAtencionService {
  private readonly _borrador = signal<BorradorPresupuestoAtencion | null>(null);

  set(borrador: BorradorPresupuestoAtencion): void {
    this._borrador.set(borrador);
  }

  /** Devuelve el borrador pendiente y lo limpia en la misma operación. */
  consumir(): BorradorPresupuestoAtencion | null {
    const b = this._borrador();
    this._borrador.set(null);
    return b;
  }
}
