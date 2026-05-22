import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TooltipModule } from 'primeng/tooltip';
import { AuthService } from '../../auth/auth.service';

/**
 * Chip compacto con el nombre del operador logueado. Se inserta en los
 * toolbars de las páginas autenticadas (showroom, pedidos, historial, etc.)
 * para que el operador sepa en cualquier momento con qué cuenta está
 * trabajando — relevante en PCs compartidas donde varios operadores se
 * loguean a lo largo del día.
 *
 * <p>En mobile (sm:hidden) se oculta para no comer espacio del toolbar.
 * En desktop muestra el nombre (o username como fallback) precedido por
 * un ícono. Si no hay sesión activa, no se renderiza nada — sin esto, en
 * la fracción de segundo entre el mount inicial y la resolución del /me
 * mostraría "—" o algo similar.
 */
@Component({
  selector: 'app-user-chip',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, TooltipModule],
  template: `
    @if (auth.currentUser(); as u) {
      <span class="hidden md:inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-[#3B1E09] dark:text-surface-0 bg-orange-100/70 dark:bg-surface-800 rounded-full border border-orange-200 dark:border-surface-700"
        [pTooltip]="'Sesión iniciada como ' + u.username" tooltipPosition="bottom">
        <i class="pi pi-user text-[#FF861C]"></i>
        <span class="leading-none">{{ u.nombre || u.username }}</span>
      </span>
    }
  `,
})
export class UserChip {
  readonly auth = inject(AuthService);
}
