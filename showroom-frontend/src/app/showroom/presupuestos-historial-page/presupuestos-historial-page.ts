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
import { ConfirmationService, MenuItem, MessageService } from 'primeng/api';
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
import { UserChip } from '../user-chip/user-chip';

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
    UserChip,
  ],
  templateUrl: './presupuestos-historial-page.html',
  styleUrl: './presupuestos-historial-page.scss',
})
export class PresupuestosHistorialPage {
  private readonly api = inject(ShowroomService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly confirmationService = inject(ConfirmationService);
  private readonly route = inject(ActivatedRoute);

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

  /** IDs de presupuestos cuyo PDF se está descargando — para deshabilitar
   *  el botón mientras espera el response del backend. */
  readonly descargandoPdf = signal<Set<number>>(new Set());

  /** IDs de presupuestos que se están eliminando — para deshabilitar el
   *  botón mientras espera el response del backend. */
  readonly eliminandoPdf = signal<Set<number>>(new Set());

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
    // Pre-llena la búsqueda con el queryParam `q` cuando se navega desde la
    // página de Clientes ("Ver presupuestos de este cliente").
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
    // Truco anti-popup-blocker: abrimos la pestaña en blanco AHORA, sincrónico
    // con el click. Chrome lo trata como user-initiated y no la bloquea.
    // Cuando llega el PDF del backend, le seteamos la URL del blob.
    const previewTab = window.open('about:blank', '_blank');
    this.descargandoPdf.update((s) => new Set([...s, p.id]));
    this.api.descargarPdfPresupuestoComercial(p.id, modo).subscribe({
      next: (res) => {
        this.removerDescargando(p.id);
        const blob = res.body;
        if (!blob) {
          if (previewTab) previewTab.close();
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
        if (previewTab) previewTab.location.href = url;
        // 60s — la pestaña preview necesita el URL para renderizar el PDF;
        // si lo revocamos antes, la pestaña muestra "página no encontrada".
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
        this.toast.add({
          severity: 'success',
          summary: 'PDF descargado',
          detail: `#${p.id} — se abrió para previsualizar.`,
          life: 4000,
        });
      },
      error: (err) => {
        if (previewTab) previewTab.close();
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

  /** Confirma con un dialog modal antes de eliminar — el operador puede
   *  borrar por error y el soft-delete es reversible solo desde la DB, así
   *  que es bueno pedir confirmación explícita con el id + nombre del
   *  cliente para que se asegure. */
  confirmarEliminar(p: PresupuestoListItem): void {
    if (this.eliminandoPdf().has(p.id)) return;
    const refCliente = p.clienteNombre ? ` de ${p.clienteNombre}` : '';
    this.confirmationService.confirm({
      header: '¿Eliminar presupuesto?',
      message: `Se va a eliminar el presupuesto #${p.id}${refCliente}. `
        + 'No vas a poder reverlo en el historial. ¿Confirmás?',
      icon: 'pi pi-exclamation-triangle',
      acceptButtonProps: { label: 'Eliminar', severity: 'danger', icon: 'pi pi-trash' },
      rejectButtonProps: { label: 'Cancelar', severity: 'secondary', outlined: true },
      accept: () => this.ejecutarEliminar(p),
    });
  }

  private ejecutarEliminar(p: PresupuestoListItem): void {
    this.eliminandoPdf.update((s) => new Set([...s, p.id]));
    this.api.eliminarPresupuestoComercial(p.id).subscribe({
      next: () => {
        this.eliminandoPdf.update((s) => {
          const ns = new Set(s);
          ns.delete(p.id);
          return ns;
        });
        // Update optimista en memoria — sacamos la fila del listado al
        // toque para que la UI reaccione sin esperar el recargado.
        this.presupuestos.set(this.presupuestos().filter((x) => x.id !== p.id));
        this.total.update((t) => Math.max(0, t - 1));
        this.menuCache.delete(p.id);
        this.toast.add({
          severity: 'success',
          summary: 'Presupuesto eliminado',
          detail: `#${p.id} ya no aparece en el historial.`,
          life: 4000,
        });
      },
      error: (err) => {
        this.eliminandoPdf.update((s) => {
          const ns = new Set(s);
          ns.delete(p.id);
          return ns;
        });
        toastError(this.toast, 'Eliminar', err, 'No se pudo eliminar el presupuesto.');
      },
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
