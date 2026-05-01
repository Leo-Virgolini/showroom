import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, tap, throwError } from 'rxjs';
import { BackendStatusService } from './backend-status.service';

/**
 * Detecta caídas del backend mirando los responses HTTP:
 *  - status 0 → red caída / backend no responde / CORS → marca desconectado
 *  - cualquier response (OK o error con status > 0) → marca conectado, porque
 *    el backend está respondiendo aunque sea con un 400/500.
 *
 * BackendStatusService se encarga de pollear /health cada 10s mientras esté
 * desconectado para detectar la vuelta sin requerir una acción del usuario.
 */
export const backendStatusInterceptor: HttpInterceptorFn = (req, next) => {
  const statusService = inject(BackendStatusService);
  return next(req).pipe(
    tap({
      next: () => statusService.markConnected(),
    }),
    catchError((err) => {
      if (err.status === 0) {
        statusService.markDisconnected();
      } else {
        // Llegó un response del backend (aunque sea un 4xx/5xx) → la red anda.
        statusService.markConnected();
      }
      return throwError(() => err);
    }),
  );
};
