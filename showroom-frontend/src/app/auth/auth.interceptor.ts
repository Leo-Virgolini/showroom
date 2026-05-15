import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { EMPTY, catchError, throwError } from 'rxjs';
import { AuthService } from './auth.service';

/**
 * Interceptor de autenticación:
 *  - Si un request al API devuelve 401, limpiamos la sesión local y redirigimos
 *    a /login (excepto si la URL ya es /login o /api/auth/me — sino loop).
 *  - Tras el redirect, devolvemos {@code EMPTY}: el `error:` callback de los
 *    subscribers nunca se ejecuta. Sin esto, múltiples requests en vuelo al
 *    momento del vencimiento de sesión disparaban un toast cada uno — el
 *    redirect ya es el feedback al usuario.
 *  - Endpoints de auth (/api/auth/login, /api/auth/me) propagan el error
 *    normalmente: sus callers los manejan explícitamente (login-page muestra
 *    "credenciales inválidas", cargarSesionInicial cae a null).
 *  - El cookie de sesión lo manda el browser solo (mismo origen).
 *  - El header X-XSRF-TOKEN lo agrega Angular automáticamente con
 *    {@code withXsrfConfiguration} (configurado en app.config).
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  const router = inject(Router);

  return next(req).pipe(
    catchError((err) => {
      if (err.status === 401) {
        const url = req.url;
        const esEndpointAuth = url.endsWith('/api/auth/login') || url.endsWith('/api/auth/me');
        if (!esEndpointAuth) {
          // Diagnóstico de pérdida de sesión: dejá esto un par de días para
          // poder identificar QUÉ request fue el primero que devolvió 401 y
          // en qué ruta del frontend estábamos. Cuando esté resuelto, sacar.
          console.warn('[auth-interceptor] 401 en', url, '→ redirect /login. Ruta actual:', router.url);
          auth.currentUser.set(null);
          // Sólo redirigir si todavía no estamos en /login o /visor (rutas públicas).
          const ruta = router.url.split('?')[0];
          if (ruta !== '/login' && ruta !== '/visor') {
            router.navigate(['/login'], {
              queryParams: { redirect: ruta },
            });
          }
          return EMPTY;
        }
      }
      return throwError(() => err);
    }),
  );
};
