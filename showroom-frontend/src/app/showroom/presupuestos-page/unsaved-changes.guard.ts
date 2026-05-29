import { inject } from '@angular/core';
import { CanDeactivateFn } from '@angular/router';
import { ConfirmationService } from 'primeng/api';
import { Observable } from 'rxjs';

/** Contrato que debe implementar cualquier componente que quiera usar el
 *  guard {@link unsavedChangesGuard}. El guard llama a este método antes
 *  de permitir la navegación; si devuelve `true`, abre un confirm dialog
 *  ofreciendo "Salir sin guardar" o "Volver". */
export interface HasUnsavedChanges {
  /** Devuelve `true` cuando hay cambios locales que el operador todavía
   *  no persistió (en edición de un presupuesto: ítems editados, datos
   *  del cliente modificados, etc.). El guard solo bloquea cuando esto
   *  es true; durante la creación inicial NO bloquea porque el operador
   *  simplemente abandona el armado. */
  hasUnsavedChanges(): boolean;
}

/** Intercepta la navegación cuando hay cambios sin guardar. Usa el
 *  {@link ConfirmationService} de PrimeNG (renderizado con el
 *  `<p-confirmDialog>` global en app.html) para que el operador decida
 *  si sale o vuelve a la edición.
 *
 *  <p>NOTA: cubre la navegación dentro de la SPA (links del toolbar,
 *  botón "Volver", router programático). Para refresh/cerrar pestaña se
 *  necesita además un `beforeunload` listener en el componente — el guard
 *  no llega ahí porque el router no participa. */
export const unsavedChangesGuard: CanDeactivateFn<HasUnsavedChanges> = (component) => {
  if (!component.hasUnsavedChanges()) return true;
  const confirmation = inject(ConfirmationService);
  return new Observable<boolean>((subscriber) => {
    confirmation.confirm({
      header: 'Cambios sin guardar',
      message:
        'Tenés cambios en este presupuesto que todavía no guardaste. ' +
        'Si salís ahora, se van a perder.',
      icon: 'pi pi-exclamation-triangle',
      acceptButtonProps: {
        label: 'Salir sin guardar',
        icon: 'pi pi-sign-out',
        severity: 'danger',
      },
      rejectButtonProps: {
        label: 'Volver a editar',
        icon: 'pi pi-pencil',
        severity: 'secondary',
        outlined: true,
      },
      accept: () => {
        subscriber.next(true);
        subscriber.complete();
      },
      reject: () => {
        subscriber.next(false);
        subscriber.complete();
      },
    });
  });
};
