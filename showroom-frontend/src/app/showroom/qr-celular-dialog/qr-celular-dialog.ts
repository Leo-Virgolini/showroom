import { ChangeDetectionStrategy, Component, input, model, output } from '@angular/core';
import { DialogModule } from 'primeng/dialog';
import { ImageModule } from 'primeng/image';

/**
 * Diálogo "QR para celular" con dos códigos: el visor de la página (dinámico,
 * provisto por inputs) y la reseña de Google (estático).
 *
 * <p>Unificado entre el showroom y el armado de presupuestos: lo único que
 * cambia es el visor del medio — el showroom pasa su visor producto-a-producto
 * y el presupuestador el visor del presupuesto. El padre provee la URL, el
 * dataURL del QR ya generado, el estado "generando" y el título de la sección.
 *
 * <p>El padre controla la visibilidad con {@code [(visible)]} y maneja el
 * cierre (ej. devolver el foco al input de scan) vía {@link dialogClosed}.
 */
@Component({
  selector: 'app-qr-celular-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DialogModule, ImageModule],
  template: `
    <p-dialog header="QR para celular" [visible]="visible()" (visibleChange)="visible.set($event)"
      [modal]="true" [style]="{ width: '98vw', maxWidth: '140rem', maxHeight: '98vh' }"
      [breakpoints]="{ '1280px': '98vw', '768px': '98vw' }" [draggable]="false"
      [pt]="{ root: { class: 'dialog-qr-celular' } }" (onHide)="dialogClosed.emit()">
      <div class="grid grid-cols-1 md:grid-cols-2 gap-3 md:gap-4 md:divide-x md:divide-surface-200 dark:md:divide-surface-700">

        <!-- 1. Visor (dinámico, provisto por el padre) -->
        <div class="flex flex-col items-center gap-1.5 md:pr-3">
          <div class="w-full flex items-center gap-1.5">
            <i class="pi pi-mobile text-[#FF861C] text-base"></i>
            <h3 class="text-sm font-bold text-[#3B1E09] dark:text-surface-0 m-0">1. {{ visorTitulo() }}</h3>
          </div>
          @if (qrDataUrl()) {
          <p-image [src]="qrDataUrl()!" alt="QR del visor" [preview]="true"
            imageClass="w-full max-h-[70vh] object-contain rounded-xl shadow-sm cursor-zoom-in bg-white" class="w-full" />
          <div class="text-[10px] font-mono text-muted-color break-all text-center max-w-full select-all">
            {{ visorUrl() }}
          </div>
          } @else if (generando()) {
          <div class="w-full aspect-square max-h-[70vh] rounded-xl bg-surface-100 dark:bg-surface-800 flex items-center justify-center">
            <i class="pi pi-spin pi-spinner text-3xl text-muted-color"></i>
          </div>
          } @else {
          <!-- No se pudo generar el QR — mostramos la URL como fallback. -->
          <div class="w-full aspect-square max-h-[70vh] rounded-xl bg-surface-100 dark:bg-surface-800 flex flex-col items-center justify-center gap-2 p-4 text-center">
            <i class="pi pi-exclamation-triangle text-2xl text-muted-color"></i>
            <span class="text-xs text-muted-color">No se pudo generar el QR. Ingresá esta dirección en el celular:</span>
            <span class="text-xs font-mono text-color break-all select-all">{{ visorUrl() }}</span>
          </div>
          }
        </div>

        <!-- 2. Reseña Google (estático) -->
        <div class="flex flex-col items-center gap-1.5 md:pl-3 border-t pt-3 md:border-t-0 md:pt-0 border-surface-200 dark:border-surface-700">
          <div class="w-full flex items-center gap-1.5">
            <i class="pi pi-star-fill text-[#FF861C] text-base"></i>
            <h3 class="text-sm font-bold text-[#3B1E09] dark:text-surface-0 m-0">2. Calificanos en Google</h3>
          </div>
          <p-image src="opinion-google.png" alt="QR para reseña en Google" [preview]="true"
            imageClass="w-full max-h-[80vh] object-contain rounded-xl shadow-sm cursor-zoom-in" class="w-full" />
        </div>

      </div>
    </p-dialog>
  `,
})
export class QrCelularDialog {
  /** Visibilidad bidireccional del diálogo. */
  readonly visible = model<boolean>(false);
  /** URL del visor (se muestra como texto + fallback si no se pudo generar el QR). */
  readonly visorUrl = input<string>('');
  /** DataURL del QR del visor ya generado. Null mientras genera o si falló. */
  readonly qrDataUrl = input<string | null>(null);
  /** True mientras se está generando el QR del visor. */
  readonly generando = input<boolean>(false);
  /** Título de la sección del visor (ej. "Ver los precios" / "Ver el presupuesto"). */
  readonly visorTitulo = input<string>('Ver los precios');
  /** Se emite al cerrar el diálogo (el padre suele devolver el foco al scan). */
  readonly dialogClosed = output<void>();
}
