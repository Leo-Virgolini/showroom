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

  // Diagnóstico de pérdida de sesión: dejá esto un par de días para ver si
  // el guard se dispara sin un /me 401 explícito. Cuando esté resuelto, sacar.
  console.warn('[auth-guard] currentUser=null → redirect /login. Ruta:', state.url);
  // Sin sesión → al login, recordando dónde quería ir.
  return router.createUrlTree(['/login'], {
    queryParams: { redirect: state.url },
  });
};
