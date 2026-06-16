import { Injectable } from '@angular/core';
import { ActivatedRouteSnapshot, BaseRouteReuseStrategy } from '@angular/router';

/**
 * Estrategia de reuso de rutas que fuerza la recreación del componente cuando
 * se navega a la MISMA URL en la que ya estamos — el caso típico de clickear,
 * en el menú, el link de la pantalla en la que ya se está parado.
 *
 * <p>Por defecto Angular descarta esas navegaciones (onSameUrlNavigation:
 * 'ignore'); con 'reload' las procesa pero REUSA la instancia del componente,
 * así que su estado local (filtros de tabla, formulario de presupuesto a medio
 * cargar, etc.) sobrevive y la pantalla no arranca "en limpio". Devolviendo
 * {@code false} en {@link shouldReuseRoute} para ese caso, el componente se
 * destruye y se vuelve a crear → ngOnInit corre de nuevo y todo se resetea.
 *
 * <p>IMPORTANTE: solo afecta navegaciones a la URL idéntica. Las navegaciones
 * que solo cambian query params (deep-links como {@code /pedidos?id=5} o el
 * limpiar-filtro in-place de pedidos/historial) NO disparan el flag, así que la
 * reactividad por {@code queryParams} existente queda intacta.
 *
 * <p>El flag {@link reloadSameUrl} lo prende y apaga {@code App} escuchando los
 * eventos del router (ver app.ts): se enciende en {@code NavigationStart} cuando
 * el destino coincide con la URL actual y se apaga al terminar la navegación.
 */
@Injectable()
export class ReloadSameUrlReuseStrategy extends BaseRouteReuseStrategy {
  /** Cuando es true, la próxima evaluación de reuso recrea el componente. */
  reloadSameUrl = false;

  override shouldReuseRoute(
    future: ActivatedRouteSnapshot,
    curr: ActivatedRouteSnapshot,
  ): boolean {
    if (this.reloadSameUrl) return false;
    return super.shouldReuseRoute(future, curr);
  }
}
