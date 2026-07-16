import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  model,
  output,
  signal,
  untracked,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subject, debounceTime } from 'rxjs';
import { MessageService } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { InputTextModule } from 'primeng/inputtext';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { ClientePresupuestos } from '../models';
import { ShowroomService } from '../showroom.service';
import { toastError } from '../toast.utils';

/**
 * Selector liviano de clientes para el modal de pedido. Abre sobre el diálogo de
 * "Crear pedido en DUX" y lista TODOS los clientes guardados (incluso los que no
 * tienen razón social) con un buscador server-side y scroll con "Cargar más".
 *
 * <p>No completa el formulario por sí mismo: emite el {@link ClientePresupuestos}
 * elegido por {@link seleccionado} y el padre (crear-pedido-dialog) lo vuelca al
 * form con su lógica de "sobrescribir todo". Reusa el mismo endpoint paginado que
 * la vista /clientes ({@code ShowroomService.listarClientesPresupuestos}); no
 * requiere backend nuevo.
 */
@Component({
  selector: 'app-selector-cliente-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    FormsModule,
    ButtonModule,
    DialogModule,
    IconFieldModule,
    InputIconModule,
    InputTextModule,
    ProgressSpinnerModule,
  ],
  templateUrl: './selector-cliente-dialog.html',
})
export class SelectorClienteDialog {
  private readonly api = inject(ShowroomService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  /** Control bidireccional de la visibilidad del dialog. */
  readonly visible = model<boolean>(false);
  /** Emite el cliente elegido; el padre completa el formulario del pedido. */
  readonly seleccionado = output<ClientePresupuestos>();

  /** Mismo orden por defecto que la vista /clientes (actividad más reciente). */
  private static readonly SIZE = 50;

  readonly busqueda = signal('');
  readonly items = signal<ClientePresupuestos[]>([]);
  readonly total = signal(0);
  readonly cargando = signal(false);
  /** Próxima página a pedir (0-based). */
  private readonly page = signal(0);
  /** Quedan resultados sin traer (para mostrar "Cargar más"). */
  readonly hayMas = computed(() => this.items().length < this.total());

  /** Generación de la carga en curso: una búsqueda nueva la incrementa, así las
   *  respuestas viejas (p. ej. un "Cargar más" que quedó en vuelo cuando el
   *  operador tipeó) se descartan y no se mezclan con la lista fresca. */
  private gen = 0;

  /** Dispara la búsqueda con debounce cuando el operador tipea. */
  private readonly filtro$ = new Subject<void>();

  constructor() {
    this.filtro$
      .pipe(debounceTime(300), takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.cargar(true));

    // Al abrir, arranca de cero (búsqueda vacía → primeros clientes por actividad).
    effect(() => {
      if (this.visible()) untracked(() => this.abrir());
    });
  }

  private abrir(): void {
    this.busqueda.set('');
    this.cargar(true);
  }

  onBusqueda(v: string): void {
    this.busqueda.set(v ?? '');
    this.filtro$.next();
  }

  /** Carga una página. {@code reset} vuelve a la primera (nueva búsqueda); sino
   *  acumula la siguiente ("Cargar más"). */
  private cargar(reset: boolean): void {
    const page = reset ? 0 : this.page();
    if (reset) {
      this.items.set([]);
      this.page.set(0);
    }
    const gen = ++this.gen;
    this.cargando.set(true);
    this.api
      .listarClientesPresupuestos({
        q: this.busqueda(),
        page,
        size: SelectorClienteDialog.SIZE,
        sortField: 'ultimoMovimientoAt',
        sortOrder: 'desc',
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (resp) => {
          if (gen !== this.gen) return; // llegó tarde: otra búsqueda la reemplazó
          this.items.set(reset ? resp.items : [...this.items(), ...resp.items]);
          this.total.set(resp.total);
          this.page.set(page + 1);
          this.cargando.set(false);
        },
        error: (err) => {
          if (gen !== this.gen) return;
          this.cargando.set(false);
          toastError(this.toast, 'Clientes', err, 'No se pudieron cargar los clientes.');
        },
      });
  }

  cargarMas(): void {
    if (!this.cargando()) this.cargar(false);
  }

  elegir(cli: ClientePresupuestos): void {
    this.seleccionado.emit(cli);
    this.visible.set(false);
  }

  /** Etiqueta principal de la fila: razón social, o el nombre si no tiene razón
   *  social (mismo criterio de fallback que el autocomplete). */
  etiqueta(cli: ClientePresupuestos): string {
    return cli.razonSocial?.trim() || cli.nombre?.trim() || '(sin nombre)';
  }
}
