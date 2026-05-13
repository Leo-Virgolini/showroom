import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { ClientIdService } from './client-id.service';

/**
 * Adjunta {@code X-Client-Id} a cada request al API local. El backend usa el
 * valor para etiquetar los eventos SSE que dispara la request, así cada PC
 * puede distinguir los que originó ella misma.
 *
 * <p>Caso de uso principal: cuando se crea un pedido, el backend genera el
 * Excel pickit en background y emite un SSE a todas las PCs conectadas. Sin
 * el clientId, todas las pestañas auto-descargarían el archivo. Con él, solo
 * la pestaña origen se queda con la copia local; las demás ven el toast
 * informativo y nada más.
 *
 * <p>No se aplica a URLs absolutas (third-party APIs no necesitan el header
 * y mandarlo violaría privacidad del usuario).
 */
export const clientIdInterceptor: HttpInterceptorFn = (req, next) => {
  const lcUrl = req.url.toLowerCase();
  if (lcUrl.startsWith('http://') || lcUrl.startsWith('https://')) {
    return next(req);
  }
  if (!req.url.startsWith('/api/')) {
    return next(req);
  }
  const clientId = inject(ClientIdService).get();
  return next(req.clone({ setHeaders: { 'X-Client-Id': clientId } }));
};
