import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { RouterModule } from '@angular/router';
import { ToolbarModule } from 'primeng/toolbar';
import { TooltipModule } from 'primeng/tooltip';
import { TopActions } from '../top-actions/top-actions';

/**
 * Header compartido por todas las páginas autenticadas. Unifica la banda
 * decorativa KT + el toolbar (logo, bloque de título y {@link TopActions}) en
 * un único componente, así todas las pantallas miden y se ven igual — antes
 * cada página copiaba su propio {@code p-toolbar} y la altura variaba según el
 * contenido.
 *
 * <p>Cada página pasa su título/subtítulo/ícono y el color de fondo del toolbar
 * (literal, para que Tailwind lo genere), y proyecta sus acciones propias en
 * los slots {@code [header-start]} (junto al título: chip de sesión, "Nuevo
 * cliente", "QR") y {@code [header-end]} (antes del menú: Sincronizar, Generar
 * PDF, etc.).
 *
 * <p>Altura uniforme garantizada por la clase {@code .kt-page-header} en
 * styles.scss (min-height fijo + centrado vertical).
 */
@Component({
  selector: 'app-page-header',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterModule, ToolbarModule, TooltipModule, TopActions],
  template: `
    <div class="h-1.5 bg-gradient-to-r from-[#FF861C] via-[#a2ab00] to-[#7EBA00]"></div>
    <p-toolbar [styleClass]="'kt-page-header rounded-none border-x-0 border-t-0 !px-3 sm:!px-6 !py-1 ' + toolbarClass()">
      <ng-template #start>
        <div class="flex items-center gap-2 sm:gap-3">
          <a routerLink="/" aria-label="Ir al inicio" pTooltip="Ir al inicio" tooltipPosition="bottom"
            (click)="logoClick.emit()"
            class="shrink-0 transition-transform hover:scale-105 active:scale-95 cursor-pointer">
            <img src="kt-gastro-logo.webp" alt="Kitchen Tools Gastronomía" class="h-9 sm:h-10 object-contain" />
          </a>
          <div class="hidden sm:flex flex-col leading-tight border-l border-[#FF861C]/40 dark:border-surface-700 pl-2">
            <span class="text-sm font-bold text-[#3B1E09] dark:text-surface-0 flex items-center gap-1.5">
              @if (titleIcon()) { <i [class]="titleIcon() + ' text-[#FF861C]'"></i> }
              {{ title() }}
            </span>
            @if (subtitle()) {
              <span class="text-[0.65rem] text-muted-color">{{ subtitle() }}</span>
            }
          </div>
          <ng-content select="[header-start]" />
        </div>
      </ng-template>
      <ng-template #end>
        <div class="inline-flex items-center gap-2">
          <ng-content select="[header-end]" />
          <app-top-actions />
        </div>
      </ng-template>
    </p-toolbar>
  `,
})
export class PageHeader {
  readonly title = input.required<string>();
  readonly subtitle = input<string | null>(null);
  /** Clase de ícono PrimeNG (ej. 'pi pi-box'). Se le agrega el color KT naranja. */
  readonly titleIcon = input<string | null>(null);
  /** Clases de fondo del toolbar — literal por página para que Tailwind las genere
   *  (ej. '!bg-emerald-100 dark:!bg-surface-900'). */
  readonly toolbarClass = input<string>('');
  /** El logo navega a '/'; este output deja que la página haga algo extra
   *  (ej. el showroom scrollea al inicio). */
  readonly logoClick = output<void>();
}
