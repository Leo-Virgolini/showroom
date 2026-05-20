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
import { RouterLink } from '@angular/router';
import { Subject, debounceTime } from 'rxjs';
import { MenuItem, MessageService } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { DatePickerModule } from 'primeng/datepicker';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { InputTextModule } from 'primeng/inputtext';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { SplitButtonModule } from 'primeng/splitbutton';
import { TableLazyLoadEvent, TableModule } from 'primeng/table';
import { ToolbarModule } from 'primeng/toolbar';
import { TooltipModule } from 'primeng/tooltip';
import { PresupuestoListItem } from '../models';
import { ShowroomService } from '../showroom.service';
import { toastError } from '../toast.utils';

/**
 * Listado histórico de presupuestos comerciales guardados.
 *
 * <p>Cada presupuesto persistido en BD (al descargar el PDF o al enviar
 * por email) aparece acá. El operador puede buscar por nombre/email/
 * teléfono o filtrar por fecha, y descargar el PDF para reenviarlo.
 *
 * <p>El estado se mantiene en signals locales — no usa el carrito ni la
 * sesión del backend. La tabla es lazy-load con paginación server-side.
 */
@Component({
  selector: 'app-presupuestos-historial-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    FormsModule,
    RouterLink,
    ButtonModule,
    CardModule,
    DatePickerModule,
    IconFieldModule,
    InputIconModule,
    InputTextModule,
    ProgressSpinnerModule,
    SplitButtonModule,
    TableModule,
    ToolbarModule,
    TooltipModule,
  ],
  templateUrl: './presupuestos-historial-page.html',
  styleUrl: './presupuestos-historial-page.scss',
})
export class PresupuestosHistorialPage {
  private readonly api = inject(ShowroomService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  /** Pantalla ≥ 1024px — usado para mostrar/ocultar labels de botones. */
  readonly screenLg = signal(
    typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches,
  );

  readonly busqueda = signal('');
  readonly desde = signal<Date | null>(null);
  readonly hasta = signal<Date | null>(null);

  readonly cargando = signal(false);
  readonly presupuestos = signal<PresupuestoListItem[]>([]);
  readonly total = signal(0);
  readonly pageSize = signal(50);
  readonly first = signal(0);

  /** SKUs cuyo PDF se está descargando — para deshabilitar el botón mientras
   *  espera el response del backend. */
  readonly descargandoPdf = signal<Set<number>>(new Set());

  readonly hayFiltros = computed(
    () =>
      this.busqueda().trim().length > 0 ||
      this.desde() !== null ||
      this.hasta() !== null,
  );

  /** Cuando algún filtro cambia, reseteamos al primer page y recargamos.
   *  Debounce para que tipear en el input de búsqueda no dispare un
   *  request por cada letra. */
  private readonly filtroTrigger$ = new Subject<void>();
  /** Skip del primer disparo del effect (los signals tienen valor inicial,
   *  así que el effect corre al mount aunque no haya cambio real). Evita
   *  el doble request inicial junto con {@code onLazyLoad}. */
  private filtrosInicializados = false;

  constructor() {
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
    this.cargar(Math.floor(first / size), size);
  }

  private cargar(page: number, size: number): void {
    this.cargando.set(true);
    const desde = this.desde();
    const hasta = this.hasta();
    this.api
      .listarPresupuestosComerciales({
        q: this.busqueda(),
        desde: desde ? desde.toISOString() : undefined,
        hasta: hasta ? this.endOfDay(hasta).toISOString() : undefined,
        page,
        size,
      })
      .subscribe({
        next: (res) => {
          this.cargando.set(false);
          // Limpiamos el cache de menús del SplitButton — los presupuestos
          // que ya no están en la página actual no necesitan referencias.
          this.menuCache.clear();
          this.presupuestos.set(res.items);
          this.total.set(res.total);
        },
        error: (err) => {
          this.cargando.set(false);
          toastError(this.toast, 'Historial', err,
            'No se pudieron cargar los presupuestos.');
        },
      });
  }

  /** Convierte una fecha a 23:59:59 del mismo día — usado como cota
   *  superior del filtro "hasta" para que el rango sea inclusivo. */
  private endOfDay(d: Date): Date {
    const e = new Date(d);
    e.setHours(23, 59, 59, 999);
    return e;
  }

  /** Descarga el PDF de un presupuesto: lo abre en pestaña nueva y lo
   *  guarda a disco con su filename original.
   *
   *  @param modo Si se especifica, fuerza la versión del PDF (agregada o
   *    individual). Si se omite, el backend usa el modo con el que se
   *    generó originalmente. */
  descargar(p: PresupuestoListItem, modo?: 'agregado' | 'individual'): void {
    if (this.descargandoPdf().has(p.id)) return;
    this.descargandoPdf.update((s) => new Set([...s, p.id]));
    this.api.descargarPdfPresupuestoComercial(p.id, modo).subscribe({
      next: (res) => {
        this.removerDescargando(p.id);
        const blob = res.body;
        if (!blob) {
          toastError(this.toast, 'Descargar PDF', null, 'El backend no devolvió un PDF.');
          return;
        }
        const filename = this.extraerFilename(res.headers.get('Content-Disposition'))
          || `presupuesto-${p.id}.pdf`;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => window.open(url, '_blank'), 150);
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      },
      error: (err) => {
        this.removerDescargando(p.id);
        toastError(this.toast, 'Descargar PDF', err, 'No se pudo descargar el PDF.');
      },
    });
  }

  /** Cache de menús del SplitButton por id de presupuesto — Angular CD llama
   *  al binding `[model]` en cada render, así que sin cache se crean N×2
   *  objetos MenuItem por cada ciclo. El Map se invalida cuando el listado
   *  se recarga (presupuestos.set(...) crea una identidad nueva). */
  private readonly menuCache = new Map<number, MenuItem[]>();

  /** Items del dropdown del SplitButton de descarga — permite al operador
   *  elegir entre la versión agregada (tabla + total) y la individual
   *  (1 hoja por producto) del mismo presupuesto. El click directo al
   *  botón principal descarga la versión con la que se generó originalmente. */
  opcionesDescarga(p: PresupuestoListItem): MenuItem[] {
    const cached = this.menuCache.get(p.id);
    if (cached) return cached;
    const items: MenuItem[] = [
      {
        label: 'Versión agregada',
        icon: 'pi pi-list',
        command: () => this.descargar(p, 'agregado'),
      },
      {
        label: 'Versión individual',
        icon: 'pi pi-clone',
        command: () => this.descargar(p, 'individual'),
      },
    ];
    this.menuCache.set(p.id, items);
    return items;
  }

  private removerDescargando(id: number): void {
    this.descargandoPdf.update((s) => {
      const ns = new Set(s);
      ns.delete(id);
      return ns;
    });
  }

  private extraerFilename(disposition: string | null): string | null {
    if (!disposition) return null;
    const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
    if (!m) return null;
    const raw = m[1].trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }

  limpiarFiltros(): void {
    this.busqueda.set('');
    this.desde.set(null);
    this.hasta.set(null);
  }
}
