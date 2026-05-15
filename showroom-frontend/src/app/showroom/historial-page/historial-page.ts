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
import { DatePickerModule } from 'primeng/datepicker';
import { DialogModule } from 'primeng/dialog';
import { ImageModule } from 'primeng/image';
import { InputGroupModule } from 'primeng/inputgroup';
import { InputGroupAddonModule } from 'primeng/inputgroupaddon';
import { InputTextModule } from 'primeng/inputtext';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { SkeletonModule } from 'primeng/skeleton';
import { TableLazyLoadEvent, TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ToolbarModule } from 'primeng/toolbar';
import { TooltipModule } from 'primeng/tooltip';
import {
  SesionDetalle,
  SesionListItem,
} from '../models';
import { ShowroomService } from '../showroom.service';
import { toastError } from '../toast.utils';

@Component({
  selector: 'app-historial-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    FormsModule,
    RouterLink,
    ButtonModule,
    CardModule,
    DatePickerModule,
    DialogModule,
    ImageModule,
    InputGroupModule,
    InputGroupAddonModule,
    InputTextModule,
    ProgressSpinnerModule,
    SkeletonModule,
    TableModule,
    TagModule,
    ToolbarModule,
    TooltipModule,
  ],
  templateUrl: './historial-page.html',
  styleUrl: './historial-page.scss',
})
export class HistorialPage {
  private readonly api = inject(ShowroomService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  readonly busqueda = signal('');
  readonly desde = signal<Date | null>(null);
  readonly hasta = signal<Date | null>(null);

  readonly cargando = signal(false);
  readonly sesiones = signal<SesionListItem[]>([]);
  readonly total = signal(0);
  readonly pageSize = signal(50);
  readonly first = signal(0);

  /** Cache de detalles ya obtenidos: id → SesionDetalle. */
  readonly detalles = signal<Record<number, SesionDetalle>>({});
  readonly cargandoDetalle = signal<Set<number>>(new Set());
  /** Filas expandidas. */
  readonly expanded = signal<Record<number, boolean>>({});

  readonly hayFiltros = computed(
    () =>
      this.busqueda().trim().length > 0 ||
      this.desde() !== null ||
      this.hasta() !== null,
  );

  private readonly filtroTrigger$ = new Subject<void>();

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
      .listarSesiones({
        q: this.busqueda(),
        desde: desde ? desde.toISOString() : undefined,
        hasta: hasta ? this.endOfDay(hasta).toISOString() : undefined,
        page,
        size,
      })
      .subscribe({
        next: (resp) => {
          this.cargando.set(false);
          this.sesiones.set(resp.items);
          this.total.set(resp.total);
          // Colapsar al cambiar de página — los detalles cacheados sobreviven.
          this.expanded.set({});
        },
        error: (err) => {
          this.cargando.set(false);
          toastError(this.toast, 'Historial', err, 'No se pudo cargar el historial');
        },
      });
  }

  /** Pasa el rango de fecha al final del día (23:59:59) para incluir todo el día. */
  private endOfDay(d: Date): Date {
    const end = new Date(d);
    end.setHours(23, 59, 59, 999);
    return end;
  }

  limpiarFiltros(): void {
    this.busqueda.set('');
    this.desde.set(null);
    this.hasta.set(null);
  }

  toggleRow(s: SesionListItem): void {
    const exp = { ...this.expanded() };
    if (exp[s.id]) {
      delete exp[s.id];
      this.expanded.set(exp);
      return;
    }
    exp[s.id] = true;
    this.expanded.set(exp);
    if (!this.detalles()[s.id]) {
      this.cargarDetalle(s.id);
    }
  }

  estaExpandido(id: number): boolean {
    return !!this.expanded()[id];
  }

  estaCargandoDetalle(id: number): boolean {
    return this.cargandoDetalle().has(id);
  }

  detalle(id: number): SesionDetalle | undefined {
    return this.detalles()[id];
  }

  private cargarDetalle(id: number): void {
    const set = new Set(this.cargandoDetalle());
    set.add(id);
    this.cargandoDetalle.set(set);
    this.api.obtenerSesion(id).subscribe({
      next: (det) => {
        this.detalles.set({ ...this.detalles(), [id]: det });
        const s = new Set(this.cargandoDetalle());
        s.delete(id);
        this.cargandoDetalle.set(s);
      },
      error: (err) => {
        const s = new Set(this.cargandoDetalle());
        s.delete(id);
        this.cargandoDetalle.set(s);
        toastError(this.toast, 'Detalle', err, 'No se pudo cargar el detalle');
      },
    });
  }

  /** Estado de la sesión para el tag, considerando también el estado del
   *  pedido asociado: COMPLETADA (con pedido OK), COMPL. ANULADA (pedido
   *  cancelado después), ABANDONADA (sin pedido), o ACTIVA. */
  estadoSesion(s: SesionListItem):
    { label: string; severity: 'success' | 'warn' | 'info' | 'danger' | 'secondary' } {
    if (s.finalizadaAt == null) {
      return { label: 'ACTIVA', severity: 'info' };
    }
    if (s.pedidoId != null) {
      if (s.estadoPedido === 'ANULADO') {
        return { label: 'COMPL. — ANULADO', severity: 'danger' };
      }
      if (s.estadoPedido === 'ERROR') {
        return { label: 'COMPL. — ERROR DUX', severity: 'warn' };
      }
      if (s.estadoPedido === 'PENDIENTE') {
        return { label: 'COMPL. — PENDIENTE', severity: 'warn' };
      }
      return { label: 'COMPLETADA', severity: 'success' };
    }
    return { label: 'ABANDONADA', severity: 'secondary' };
  }

  /** Saca el IVA del precio para mostrarlo s/IVA, igual que en el detalle de pedidos. */
  precioSinIva(precioConIva: number | null, porcIva: number | null): number | null {
    if (precioConIva == null) return null;
    if (porcIva == null || porcIva === 0) return precioConIva;
    return precioConIva / (1 + porcIva / 100);
  }

  // =====================================================
  // Envío de PDF por email / WhatsApp para sesiones abandonadas (sin pedido).
  // Para sesiones con pedido los botones viven en /pedidos.
  // =====================================================

  /** True para sesiones que terminaron sin pedido y tienen al menos 1 item.
   *  Sin items no hay PDF que mandar; con pedido los botones existen en /pedidos. */
  puedeEnviarPdfSesion(s: SesionListItem): boolean {
    return s.finalizadaAt != null && s.pedidoId == null && s.cantidadEscaneados > 0;
  }

  /** Sesión que está siendo target del dialog de envío. null = dialog cerrado. */
  readonly sesionEnvio = signal<SesionListItem | null>(null);
  /** Modo del envío. */
  readonly modoEnvio = signal<'email' | 'whatsapp'>('email');
  /** Valor del input (email o telefono según modo). */
  readonly destinatarioInput = signal('');
  /** True mientras la request al backend está en vuelo (loading del botón). */
  readonly enviandoSesion = signal(false);

  abrirEnvioEmail(s: SesionListItem, event: Event): void {
    event.stopPropagation();
    if (!this.puedeEnviarPdfSesion(s)) return;
    this.sesionEnvio.set(s);
    this.modoEnvio.set('email');
    this.destinatarioInput.set('');
  }

  abrirEnvioWhatsapp(s: SesionListItem, event: Event): void {
    event.stopPropagation();
    if (!this.puedeEnviarPdfSesion(s)) return;
    this.sesionEnvio.set(s);
    this.modoEnvio.set('whatsapp');
    this.destinatarioInput.set('');
  }

  cerrarDialogEnvio(): void {
    if (this.enviandoSesion()) return; // no cerrar mientras se manda
    this.sesionEnvio.set(null);
  }

  confirmarEnvioSesion(): void {
    const sesion = this.sesionEnvio();
    const dest = this.destinatarioInput().trim();
    if (!sesion || !dest) return;
    this.enviandoSesion.set(true);
    const modo = this.modoEnvio();
    const obs = modo === 'email'
      ? this.api.enviarEmailSesion(sesion.id, dest)
      : this.api.enviarWhatsappSesion(sesion.id, dest);
    obs.subscribe({
      next: () => {
        this.enviandoSesion.set(false);
        this.sesionEnvio.set(null);
        // El resultado real (SENT / FAILED / WINDOW_CLOSED) llega vía SSE
        // picking-email o whatsapp-business (toast en app.ts).
        this.toast.add({
          severity: 'info',
          summary: modo === 'email' ? 'Email encolado' : 'WhatsApp encolado',
          detail: modo === 'email'
            ? 'Generando PDF y enviando…'
            : 'Subiendo PDF a Meta y mandando…',
          life: 3000,
        });
      },
      error: (err) => {
        this.enviandoSesion.set(false);
        toastError(this.toast, modo === 'email' ? 'Email' : 'WhatsApp', err,
          'No se pudo encolar el envío');
      },
    });
  }

  trackById = (_: number, it: SesionListItem) => it.id;
}
