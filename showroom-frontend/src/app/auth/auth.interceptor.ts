import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';
import { AuthService } from './auth.service';

/**
 * Interceptor de autenticación:
 *  - Si un request al API devuelve 401, limpiamos la sesión local y redirigimos
 *    a /login (excepto si la URL ya es /login o /api/auth/me — sino loop).
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
          auth.currentUser.set(null);
          // Sólo redirigir si todavía no estamos en /login o /visor (rutas públicas).
          const ruta = router.url.split('?')[0];
          if (ruta !== '/login' && ruta !== '/visor') {
            router.navigate(['/login'], {
              queryParams: { redirect: ruta },
            });
          }
        }
      }
      return throwError(() => err);
    }),
  );
};
