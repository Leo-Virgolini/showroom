import { ChangeDetectionStrategy, Component, inject, output, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MessageService } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { CheckboxModule } from 'primeng/checkbox';
import { DialogModule } from 'primeng/dialog';
import { TooltipModule } from 'primeng/tooltip';
import { ShowroomService } from '../showroom.service';
import { SyncStateService } from '../sync-state.service';
import { toastError } from '../toast.utils';

/**
 * Botón "Sincronizar catálogo con DUX" fusionado con el dato de última sync
 * ("Sync: hace X"), más su diálogo de confirmación. Autocontenido: inyecta el
 * estado central de sync ({@link SyncStateService}) y el servicio que dispara
 * la sincronización, así cualquier página lo usa con solo {@code <app-sync-button />}.
 *
 * <p>Reemplazó al botón + diálogo que vivían inline en el showroom y al badge
 * "Última sync" del armado de presupuestos — un único lugar para sincronizar.
 *
 * <p>El padre puede escuchar {@link dialogClosed} para hacer algo al cerrar el
 * diálogo (ej. el showroom devuelve el foco al input de scan para la pistola QR).
 */
@Component({
  selector: 'app-sync-button',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, FormsModule, ButtonModule, CheckboxModule, DialogModule, TooltipModule],
  template: `
    <p-button class="btn-kt-naranja" [disabled]="health()?.syncEnCurso === true"
      (onClick)="confirmarSincronizar()" tooltipPosition="bottom"
      ariaLabel="Sincronizar catálogo desde DUX"
      [pTooltip]="health()?.ultimaSincronizacionAt
          ? ('Última sincronización: ' + (health()!.ultimaSincronizacionAt | date: 'dd/MM/yyyy HH:mm:ss' : undefined : 'es-AR') + ' — Descarga el catálogo desde DUX')
          : 'Descarga el catálogo desde DUX'">
      <span class="inline-flex items-center gap-2">
        <i class="pi pi-sync" [class.pi-spin]="health()?.syncEnCurso === true"></i>
        @if (screenLg()) {
        <span class="flex flex-col items-start leading-tight text-left">
          <span class="font-semibold text-sm">{{ health()?.syncEnCurso ? 'Sincronizando…' : 'Sincronizar' }}</span>
          @if (health()?.ultimaSincronizacionAt; as fecha) {
          <span class="text-[10px] font-normal opacity-90">Sync: {{ tiempoRelativo(fecha) }}</span>
          }
        </span>
        }
      </span>
    </p-button>

    <p-dialog header="Sincronizar catálogo con DUX" [(visible)]="mostrarSyncDialog" [modal]="true"
      [style]="{ width: '95vw', maxWidth: '34rem' }" [breakpoints]="{ '640px': '95vw' }"
      [draggable]="false" (onHide)="dialogClosed.emit()">
      <div class="flex flex-col gap-4">
        <p class="m-0 text-surface-700 dark:text-surface-200">
          Va a correr en background — podés seguir usando el sistema.
          El banner global muestra el progreso a todos los usuarios conectados.
        </p>

        <div class="flex flex-col gap-2 p-3 rounded-lg border border-surface-200 dark:border-surface-700 bg-surface-50 dark:bg-surface-900">
          <label class="flex items-start gap-2 cursor-pointer">
            <p-checkbox [(ngModel)]="forzarSyncCompleto" [binary]="true" inputId="forzarSync" />
            <div class="flex flex-col gap-1">
              <span class="font-medium">Sincronización completa</span>
              <span class="text-xs text-muted-color flex flex-col gap-1 mt-1">
                <span><strong>Marcado:</strong> descarga TODO el catálogo desde DUX (~15 minutos).</span>
                <span><strong>Sin marcar:</strong> solo trae los productos que tuvieron cambios de <strong>stock</strong> o <strong>precio</strong> desde la última sincronización (más rápido).</span>
              </span>
            </div>
          </label>
        </div>
      </div>
      <ng-template #footer>
        <p-button label="Cancelar" severity="secondary" [outlined]="true" (onClick)="mostrarSyncDialog.set(false)" />
        <p-button [label]="forzarSyncCompleto() ? 'Sincronizar todo' : 'Sincronizar'" icon="pi pi-sync" (onClick)="ejecutarSync()" />
      </ng-template>
    </p-dialog>
  `,
})
export class SyncButton {
  private readonly api = inject(ShowroomService);
  private readonly syncState = inject(SyncStateService);
  private readonly toast = inject(MessageService);

  /** Estado de DUX/sync — fuente de verdad central, propagada vía SSE. */
  readonly health = this.syncState.health;
  readonly mostrarSyncDialog = signal(false);
  readonly forzarSyncCompleto = signal(false);
  readonly screenLg = signal(
    typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches,
  );
  /** Se emite al cerrar el diálogo de sync (el showroom devuelve el foco al scan). */
  readonly dialogClosed = output<void>();

  confirmarSincronizar(): void {
    if (this.health()?.syncEnCurso) {
      this.toast.add({
        severity: 'info',
        summary: 'Sincronización en curso',
        detail: 'Ya hay un sync corriendo en background.',
      });
      return;
    }
    this.forzarSyncCompleto.set(false);
    this.mostrarSyncDialog.set(true);
  }

  ejecutarSync(): void {
    const force = this.forzarSyncCompleto();
    this.mostrarSyncDialog.set(false);
    this.api.syncCatalogo(force).subscribe({
      next: () => {
        this.toast.add({
          severity: 'info',
          summary: force ? 'Sync completo iniciado' : 'Sincronización iniciada',
          detail: force
            ? 'Descarga todo el catálogo (~15 min). El banner global muestra el progreso.'
            : 'Va a correr en background. El banner global muestra el progreso.',
          life: 5000,
        });
        this.syncState.refrescarHealth();
      },
      error: (err) => toastError(this.toast, 'Sync', err, 'No se pudo iniciar el sync'),
    });
  }

  /** Formato relativo "hace X min/hora/día" para fechas recientes. */
  tiempoRelativo(iso: string | null | undefined): string {
    if (!iso) return '—';
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 60_000) return 'hace unos segundos';
    const min = Math.floor(ms / 60_000);
    if (min < 60) return `hace ${min} min`;
    const hs = Math.floor(min / 60);
    if (hs < 24) return `hace ${hs} h`;
    const d = Math.floor(hs / 24);
    return `hace ${d} día${d === 1 ? '' : 's'}`;
  }
}
