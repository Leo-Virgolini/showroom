import { DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Observable } from 'rxjs';
import { ClienteAutocompletar } from './models';

/**
 * Crea un chequeo reutilizable de "¿este teléfono ya pertenece a un cliente?",
 * usado por las pantallas que dan de alta clientes/presupuestos para avisar que
 * el teléfono ya está registrado. Encapsula la lógica que estaba duplicada:
 * normalizar a dígitos, exigir un mínimo de 8, deduplicar contra el último
 * número consultado y descartar respuestas tardías (si el teléfono cambió
 * mientras viajaba la request, el resultado ya no aplica).
 *
 * Devuelve una función a la que se le pasa el teléfono crudo en cada cambio.
 *
 * @param buscar      dispara el lookup (típicamente `api.buscarClientePorTelefono`)
 * @param destroyRef  cancela la suscripción al destruir el componente
 * @param onResultado recibe el cliente encontrado (o null si no hay / teléfono corto)
 */
export function crearTelefonoLookup(
  buscar: (digits: string) => Observable<ClienteAutocompletar | null>,
  destroyRef: DestroyRef,
  onResultado: (cliente: ClienteAutocompletar | null) => void,
): (telefonoRaw: string | null | undefined) => void {
  let ultimoLookup = '';
  return (telefonoRaw) => {
    const digits = (telefonoRaw ?? '').replace(/\D/g, '');
    if (digits.length < 8) {
      ultimoLookup = '';
      onResultado(null);
      return;
    }
    if (digits === ultimoLookup) return;
    ultimoLookup = digits;
    buscar(digits)
      .pipe(takeUntilDestroyed(destroyRef))
      .subscribe((cli) => {
        if (digits === ultimoLookup) onResultado(cli);
      });
  };
}
