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
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { Subject, debounceTime } from 'rxjs';
import { ConfirmationService, MessageService } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { DatePickerModule } from 'primeng/datepicker';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { InputTextModule } from 'primeng/inputtext';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { TableLazyLoadEvent, TableModule } from 'primeng/table';
import { TooltipModule } from 'primeng/tooltip';
import { CotizacionListItem } from '../models';
import { abrirPdfEnPreview } from '../download.utils';
import { ShowroomService } from '../showroom.service';
import { finDelDia, marcarEnSet, sortDesdeLazyLoad } from '../tabla.utils';
import { toastError } from '../toast.utils';
import { PageHeader } from '../page-header/page-header';

/**
 * Listado histórico de cotizaciones financieras guardadas — mismo patrón
 * que {@code PresupuestosHistorialPage} pero sobre la entidad
 * {@code CotizacionFinanciera}.
 */
@Component({
  selector: 'app-cotizador-historial-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    FormsModule,
    ButtonModule,
    CardModule,
    DatePickerModule,
    IconFieldModule,
    InputIconModule,
    InputTextModule,
    ProgressSpinnerModule,
    TableModule,
    TooltipModule,
    RouterLink,
    PageHeader,  ],
  templateUrl: './cotizador-historial-page.html',
  styleUrl: './cotizador-historial-page.scss',
})
export class CotizadorHistorialPage {
  private readonly api = inject(ShowroomService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly confirmationService = inject(ConfirmationService);
  private readonly route = inject(ActivatedRoute);

  readonly screenLg = signal(
    typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches,
  );

  readonly busqueda = signal('');
  readonly desde = signal<Date | null>(null);
  readonly hasta = signal<Date | null>(null);

  readonly cargando = signal(false);
  readonly cotizaciones = signal<CotizacionListItem[]>([]);
  readonly total = signal(0);
  readonly pageSize = signal(50);
  readonly first = signal(0);

  readonly sortField = signal<string>('creadoAt');
  readonly sortOrder = signal<'asc' | 'desc'>('desc');

  readonly descargandoPdf = signal<Set<number>>(new Set());
  readonly eliminandoPdf = signal<Set<number>>(new Set());

  readonly hayFiltros = computed(
    () =>
      this.busqueda().trim().length > 0 ||
      this.desde() !== null ||
      this.hasta() !== null,
  );

  private readonly filtroTrigger$ = new Subject<void>();
  private filtrosInicializados = false;

  constructor() {
    const qParam = this.route.snapshot.queryParamMap.get('q');
    if (qParam) {
      this.busqueda.set(qParam);
    }

    this.filtroTrigger$
      .pipe(debounceTime(300), takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.first.set(0);
        this.cargar(0, this.pageSize());
      });

    effect(() => {
      this.busqueda();
      this.desde();
      this.hasta();
      if (!this.filtrosInicializados) {
        this.filtrosInicializados = true;
        return;
      }
      this.filtroTrigger$.next();
    });
  }

  onLazyLoad(event: TableLazyLoadEvent): void {
    const size = event.rows ?? this.pageSize();
    const first = event.first ?? 0;
    this.pageSize.set(size);
    this.first.set(first);
    const { sortField, sortOrder } = sortDesdeLazyLoad(event, this.sortField(), this.sortOrder());
    this.sortField.set(sortField);
    this.sortOrder.set(sortOrder);
    this.cargar(Math.floor(first / size), size);
  }

  private cargar(page: number, size: number): void {
    this.cargando.set(true);
    const desde = this.desde();
    const hasta = this.hasta();
    this.api
      .listarCotizacionesFinancieras({
        q: this.busqueda(),
        desde: desde ? desde.toISOString() : undefined,
        hasta: hasta ? finDelDia(hasta).toISOString() : undefined,
        page,
        size,
        sortField: this.sortField(),
        sortOrder: this.sortOrder(),
      })
      .subscribe({
        next: (res) => {
          this.cargando.set(false);
          this.cotizaciones.set(res.items);
          this.total.set(res.total);
        },
        error: (err) => {
          this.cargando.set(false);
          toastError(this.toast, 'Historial', err,
            'No se pudieron cargar las cotizaciones.');
        },
      });
  }

  descargar(c: CotizacionListItem): void {
    if (this.descargandoPdf().has(c.id)) return;
    // Pestaña preview abierta sincrónica con el click — anti popup-blocker.
    // El PDF se renderiza ahí cuando llega; NO se auto-descarga, si el
    // operador quiere bajarlo a disco lo hace desde el visor del browser.
    const previewTab = window.open('about:blank', '_blank');
    marcarEnSet(this.descargandoPdf, c.id, true);
    this.api.descargarPdfCotizacionFinanciera(c.id).subscribe({
      next: (res) => {
        marcarEnSet(this.descargandoPdf, c.id, false);
        const resultado = abrirPdfEnPreview(res, `cotizacion-${c.id}.pdf`, previewTab);
        if (resultado == null) {
          toastError(this.toast, 'Abrir PDF', null, 'El backend no devolvió un PDF.');
          return;
        }
        this.toast.add({
          severity: 'success',
          summary: resultado.previewAbierto ? 'PDF abierto' : 'PDF descargado',
          detail: resultado.previewAbierto
            ? `#${c.id} — se abrió para previsualizar.`
            : `#${c.id} — el browser bloqueó la pestaña preview.`,
          life: 3500,
        });
      },
      error: (err) => {
        if (previewTab) previewTab.close();
        marcarEnSet(this.descargandoPdf, c.id, false);
        toastError(this.toast, 'Abrir PDF', err, 'No se pudo abrir el PDF.');
      },
    });
  }

  confirmarEliminar(c: CotizacionListItem): void {
    if (this.eliminandoPdf().has(c.id)) return;
    const refCliente = c.clienteNombre ? ` de ${c.clienteNombre}` : '';
    this.confirmationService.confirm({
      header: '¿Eliminar cotización?',
      message: `Se va a eliminar la cotización #${c.id}${refCliente}. `
        + 'No vas a poder reverla en el historial. ¿Confirmás?',
      icon: 'pi pi-exclamation-triangle',
      acceptButtonProps: { label: 'Eliminar', severity: 'danger', icon: 'pi pi-trash' },
      rejectButtonProps: { label: 'Cancelar', severity: 'secondary', outlined: true },
      accept: () => this.ejecutarEliminar(c),
    });
  }

  private ejecutarEliminar(c: CotizacionListItem): void {
    marcarEnSet(this.eliminandoPdf, c.id, true);
    this.api.eliminarCotizacionFinanciera(c.id).subscribe({
      next: () => {
        marcarEnSet(this.eliminandoPdf, c.id, false);
        this.cotizaciones.set(this.cotizaciones().filter((x) => x.id !== c.id));
        this.total.update((t) => Math.max(0, t - 1));
        this.toast.add({
          severity: 'success',
          summary: 'Cotización eliminada',
          detail: `#${c.id} ya no aparece en el historial.`,
          life: 4000,
        });
      },
      error: (err) => {
        marcarEnSet(this.eliminandoPdf, c.id, false);
        toastError(this.toast, 'Eliminar', err, 'No se pudo eliminar la cotización.');
      },
    });
  }

  limpiarFiltros(): void {
    this.busqueda.set('');
    this.desde.set(null);
    this.hasta.set(null);
  }
}
