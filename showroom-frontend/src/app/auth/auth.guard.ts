import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { AuthService } from './auth.service';

/**
 * Guard que protege rutas que requieren login. Si todavía no se resolvió
 * la sesión inicial (primera carga de la app), espera. Si no hay sesión,
 * redirige a /login conservando la ruta solicitada como queryParam para
 * volver después del login.
 */
export const authGuard: CanActivateFn = async (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);

  // Si todavía no resolvió, esperá a la primera respuesta de /me.
  if (!auth.resolved()) {
    await firstValueFrom(auth.cargarSesionInicial());
  }

  if (auth.currentUser()) {
    return true;
  }

  // Sin sesión → al login, recordando dónde quería ir.
  return router.createUrlTree(['/login'], {
    queryParams: { redirect: state.url },
  });
};
