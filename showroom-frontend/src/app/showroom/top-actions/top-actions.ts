import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TooltipModule } from 'primeng/tooltip';
import { AuthService } from '../../auth/auth.service';
import { MainMenu } from '../main-menu/main-menu';
import { UserChip } from '../user-chip/user-chip';

/**
 * Acciones de la derecha del toolbar, comunes a todas las páginas
 * autenticadas: navegación ({@link MainMenu}), identidad del operador
 * ({@link UserChip}) y cierre de sesión.
 *
 * <p>Antes estos tres elementos vivían sueltos y copiados a mano en el
 * toolbar de cada {@code *-page} (más un {@code cerrarSesion()} duplicado en
 * cada componente). Era frágil: una página nueva que no copiara el botón
 * quedaba sin logout. Encapsulados aquí, el cierre de sesión está garantizado
 * donde se inserte {@code <app-top-actions />} y existe en un único lugar.
 *
 * <p>El host usa {@code display: contents} para no introducir un wrapper que
 * rompa el {@code flex} del toolbar contenedor — los tres controles participan
 * directamente del mismo {@code gap}.
 */
@Component({
  selector: 'app-top-actions',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'contents' },
  imports: [ButtonModule, TooltipModule, MainMenu, UserChip],
  template: `
    <app-main-menu />
    <app-user-chip />
    <p-button icon="pi pi-sign-out" ariaLabel="Cerrar sesión" class="btn-kt-rojo"
      (onClick)="cerrarSesion()" pTooltip="Cerrar sesión" tooltipPosition="bottom" />
  `,
})
export class TopActions {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  cerrarSesion(): void {
    this.auth.logout().subscribe({
      // En ambos casos vamos al login — el logout ya limpió el signal local.
      next: () => this.router.navigate(['/login']),
      error: () => this.router.navigate(['/login']),
    });
  }
}
