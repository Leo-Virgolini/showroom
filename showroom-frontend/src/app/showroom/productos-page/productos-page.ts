import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subject, debounceTime } from 'rxjs';
import { MessageService } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { InputTextModule } from 'primeng/inputtext';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { TableLazyLoadEvent, TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { ToolbarModule } from 'primeng/toolbar';
import { TooltipModule } from 'primeng/tooltip';
import { ProductoListItem } from '../models';
import { ShowroomService } from '../showroom.service';
import { toastError } from '../toast.utils';

@Component({
  selector: 'app-productos-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    FormsModule,
    RouterLink,
    ButtonModule,
    CardModule,
    IconFieldModule,
    InputIconModule,
    InputTextModule,
    ProgressSpinnerModule,
    TableModule,
    TagModule,
    ToggleSwitchModule,
    ToolbarModule,
    TooltipModule,
  ],
  templateUrl: './productos-page.html',
  styleUrl: './productos-page.scss',
})
export class ProductosPage {
  private readonly api = inject(ShowroomService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  readonly busqueda = signal('');
  readonly soloDeshabilitados = signal(false);
  readonly soloSinStock = signal(false);

  readonly cargando = signal(false);
  readonly productos = signal<ProductoListItem[]>([]);
  readonly total = signal(0);

  /** Tamaño de página actual — sincronizado con el p-table. */
  readonly pageSize = signal(50);
  /** Primer índice de fila visible (PrimeNG `first`). */
  readonly first = signal(0);
  /** Campo de orden actual — coincide con los keys del SORT_PRODUCTOS del backend. */
  readonly sortField = signal<string>('sku');
  readonly sortOrder = signal<'asc' | 'desc'>('asc');

  /** SKUs en proceso de refresh individual — se muestra un spinner por fila. */
  readonly refrescando = signal<Set<string>>(new Set());

  /**
   * Disparador para refetch debounced cuando cambian los filtros (busqueda + toggles).
   * Volvemos a página 0 al cambiar filtros.
   */
  private readonly filtroTrigger$ = new Subject<void>();

  readonly hayFiltros = computed(
    () =>
      this.busqueda().trim().length > 0 ||
      this.soloDeshabilitados() ||
      this.soloSinStock(),
  );

  constructor() {
    this.filtroTrigger$
      .pipe(debounceTime(300), takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.first.set(0);
        this.cargar(0, this.pageSize());
      });

    effect(() => {
      // Re-evaluamos cada vez que cambian los filtros.
      this.busqueda();
      this.soloDeshabilitados();
      this.soloSinStock();
      this.filtroTrigger$.next();
    });
  }

  onLazyLoad(event: TableLazyLoadEvent): void {
    const size = event.rows ?? this.pageSize();
    const first = event.first ?? 0;
    this.pageSize.set(size);
    this.first.set(first);
    if (typeof event.sortField === 'string' && event.sortField) {
      this.sortField.set(event.sortField);
    }
    if (event.sortOrder === 1 || event.sortOrder === -1) {
      this.sortOrder.set(event.sortOrder === 1 ? 'asc' : 'desc');
    }
    const page = Math.floor(first / size);
    this.cargar(page, size);
  }

  private cargar(page: number, size: number): void {
    this.cargando.set(true);
    this.api
      .listarProductos({
        q: this.busqueda(),
        soloDeshabilitados: this.soloDeshabilitados(),
        soloSinStock: this.soloSinStock(),
        page,
        size,
        sortField: this.sortField(),
        sortOrder: this.sortOrder(),
      })
      .subscribe({
        next: (resp) => {
          this.cargando.set(false);
          this.productos.set(resp.items);
          this.total.set(resp.total);
        },
        error: (err) => {
          this.cargando.set(false);
          toastError(this.toast, 'Productos', err, 'No se pudo cargar el listado');
        },
      });
  }

  limpiarFiltros(): void {
    this.busqueda.set('');
    this.soloDeshabilitados.set(false);
    this.soloSinStock.set(false);
  }

  refrescarFila(sku: string): void {
    const set = new Set(this.refrescando());
    set.add(sku);
    this.refrescando.set(set);

    this.api.refreshStock([sku]).subscribe({
      next: (resultados) => {
        this.quitarRefrescando(sku);
        const r = resultados[0];
        if (!r) return;
        this.productos.set(
          this.productos().map((p) =>
            p.sku === sku
              ? {
                  ...p,
                  stockTotal: r.stockTotal,
                  pvpKtGastroConIva: r.pvpKtGastroConIva,
                  pvpKtGastroSinIva: r.pvpKtGastroSinIva,
                  porcIva: r.porcIva,
                  habilitado: r.habilitado,
                  sincronizadoAt: r.sincronizadoAt,
                }
              : p,
          ),
        );
        this.toast.add({
          severity: 'success',
          summary: 'Stock actualizado',
          detail: `${sku} — stock: ${r.stockTotal ?? 0}`,
          life: 2500,
        });
      },
      error: (err) => {
        this.quitarRefrescando(sku);
        toastError(this.toast, 'Refrescar', err, 'No se pudo refrescar');
      },
    });
  }

  private quitarRefrescando(sku: string): void {
    const set = new Set(this.refrescando());
    set.delete(sku);
    this.refrescando.set(set);
  }

  estaRefrescando(sku: string): boolean {
    return this.refrescando().has(sku);
  }

  trackBySku = (_: number, it: ProductoListItem) => it.sku;
}
