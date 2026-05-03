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
import { HttpResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subject, debounceTime } from 'rxjs';
import { MessageService } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { DatePickerModule } from 'primeng/datepicker';
import { IconFieldModule } from 'primeng/iconfield';
import { ImageModule } from 'primeng/image';
import { InputIconModule } from 'primeng/inputicon';
import { InputTextModule } from 'primeng/inputtext';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { SelectModule } from 'primeng/select';
import { TableLazyLoadEvent, TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ToolbarModule } from 'primeng/toolbar';
import { TooltipModule } from 'primeng/tooltip';
import {
  EstadoPedido,
  PedidoDetalle,
  PedidoListItem,
} from '../models';
import { ShowroomService } from '../showroom.service';
import { toastError } from '../toast.utils';

@Component({
  selector: 'app-pedidos-page',
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
    ImageModule,
    InputIconModule,
    InputTextModule,
    ProgressSpinnerModule,
    SelectModule,
    TableModule,
    TagModule,
    ToolbarModule,
    TooltipModule,
  ],
  templateUrl: './pedidos-page.html',
  styleUrl: './pedidos-page.scss',
})
export class PedidosPage {
  private readonly api = inject(ShowroomService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  readonly busqueda = signal('');
  readonly estado = signal<EstadoPedido | null>(null);
  readonly desde = signal<Date | null>(null);
  readonly hasta = signal<Date | null>(null);

  readonly cargando = signal(false);
  readonly pedidos = signal<PedidoListItem[]>([]);
  readonly total = signal(0);
  readonly pageSize = signal(50);
  readonly first = signal(0);
  /** Campo de orden actual — coincide con los keys de `SORT_PEDIDOS` del backend. */
  readonly sortField = signal<string>('creadoAt');
  readonly sortOrder = signal<'asc' | 'desc'>('desc');

  /** Cache de detalles ya obtenidos: id → PedidoDetalle. Se carga al expandir. */
  readonly detalles = signal<Record<number, PedidoDetalle>>({});
  readonly cargandoDetalle = signal<Set<number>>(new Set());

  /** IDs de pedido cuyo Excel/PDF se está descargando — para deshabilitar el botón. */
  readonly descargandoExcel = signal<Set<number>>(new Set());
  readonly descargandoPdf = signal<Set<number>>(new Set());
  readonly enviandoEmail = signal<Set<number>>(new Set());

  /** Filas expandidas (row expansion del p-table). */
  readonly expanded = signal<Record<number, boolean>>({});

  readonly opcionesEstado: { label: string; value: EstadoPedido | null }[] = [
    { label: 'Todos', value: null },
    { label: 'ENVIADO', value: 'ENVIADO' },
    { label: 'PENDIENTE', value: 'PENDIENTE' },
    { label: 'ERROR', value: 'ERROR' },
  ];

  readonly hayFiltros = computed(
    () =>
      this.busqueda().trim().length > 0 ||
      this.estado() !== null ||
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
      this.estado();
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
    // Cuando el usuario clickea un header, p-table pasa sortField y sortOrder
    // (1 = asc, -1 = desc). Si no clickea, viene el valor del [sortField] del
    // template, así que el primer load también respeta el default.
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
    const desde = this.desde();
    const hasta = this.hasta();
    this.api
      .listarPedidos({
        q: this.busqueda(),
        estado: this.estado() ?? undefined,
        desde: desde ? desde.toISOString() : undefined,
        hasta: hasta ? this.endOfDay(hasta).toISOString() : undefined,
        page,
        size,
        sortField: this.sortField(),
        sortOrder: this.sortOrder(),
      })
      .subscribe({
        next: (resp) => {
          this.cargando.set(false);
          this.pedidos.set(resp.items);
          this.total.set(resp.total);
          // Al cambiar la página, colapsar las filas expandidas (los detalles ya
          // cacheados siguen sirviendo si el usuario re-expande).
          this.expanded.set({});
        },
        error: (err) => {
          this.cargando.set(false);
          toastError(this.toast, 'Pedidos', err, 'No se pudo cargar el listado');
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
    this.estado.set(null);
    this.desde.set(null);
    this.hasta.set(null);
  }

  toggleRow(p: PedidoListItem): void {
    const exp = { ...this.expanded() };
    if (exp[p.id]) {
      delete exp[p.id];
      this.expanded.set(exp);
      return;
    }
    exp[p.id] = true;
    this.expanded.set(exp);
    if (!this.detalles()[p.id]) {
      this.cargarDetalle(p.id);
    }
  }

  estaExpandido(id: number): boolean {
    return !!this.expanded()[id];
  }

  estaCargandoDetalle(id: number): boolean {
    return this.cargandoDetalle().has(id);
  }

  detalle(id: number): PedidoDetalle | undefined {
    return this.detalles()[id];
  }

  private cargarDetalle(id: number): void {
    const set = new Set(this.cargandoDetalle());
    set.add(id);
    this.cargandoDetalle.set(set);
    this.api.obtenerPedido(id).subscribe({
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

  estadoSeverity(e: EstadoPedido): 'success' | 'warn' | 'danger' {
    if (e === 'ENVIADO') return 'success';
    if (e === 'PENDIENTE') return 'warn';
    return 'danger';
  }

  /** Saca el IVA del precio. Devuelve null si no hay IVA almacenado (pedidos viejos). */
  precioSinIva(precioConIva: number | null, porcIva: number | null): number | null {
    if (precioConIva == null) return null;
    if (porcIva == null || porcIva === 0) return precioConIva;
    return precioConIva / (1 + porcIva / 100);
  }

  /** Subtotal s/IVA por línea — lo que el cliente paga por ese ítem (sin descuento global). */
  subtotalSinIva(it: { precioUnitario: number | null; porcIva: number | null; cantidad: number | null }): number | null {
    const p = this.precioSinIva(it.precioUnitario, it.porcIva);
    if (p == null || it.cantidad == null) return null;
    return p * it.cantidad;
  }

  /** Monto total del IVA del pedido (total con IVA - total sin IVA). Usa los campos
   *  guardados en el pedido — null si alguno falta (pedidos viejos sin totalSinIva). */
  ivaTotal(det: PedidoDetalle): number | null {
    if (det.total == null || det.totalSinIva == null) return null;
    return det.total - det.totalSinIva;
  }

  trackById = (_: number, it: PedidoListItem) => it.id;

  estaDescargandoExcel(id: number): boolean {
    return this.descargandoExcel().has(id);
  }

  estaDescargandoPdf(id: number): boolean {
    return this.descargandoPdf().has(id);
  }

  estaEnviandoEmail(id: number): boolean {
    return this.enviandoEmail().has(id);
  }

  reenviarEmail(p: PedidoListItem): void {
    if (this.estaEnviandoEmail(p.id)) return;
    this.marcarDescarga(this.enviandoEmail, p.id, true);
    this.api.reenviarEmailPedido(p.id).subscribe({
      next: () => {
        this.marcarDescarga(this.enviandoEmail, p.id, false);
        // El toast de éxito real lo dispara el SSE picking-email cuando el async
        // completa (en app.ts). Mostramos solo un info inmediato para confirmar
        // que la acción se aceptó.
        this.toast.add({
          severity: 'info',
          summary: 'Email encolado',
          detail: 'Generando adjuntos y enviando…',
          life: 3000,
        });
      },
      error: (err) => {
        this.marcarDescarga(this.enviandoEmail, p.id, false);
        toastError(this.toast, 'Email', err, 'No se pudo encolar el envío');
      },
    });
  }

  descargarExcel(p: PedidoListItem): void {
    if (this.estaDescargandoExcel(p.id)) return;
    this.marcarDescarga(this.descargandoExcel, p.id, true);
    this.api.descargarExcelPedido(p.id).subscribe({
      next: (resp) => {
        this.marcarDescarga(this.descargandoExcel, p.id, false);
        this.dispararDescarga(resp, `pedido-${p.id}.xlsx`);
      },
      error: (err) => {
        this.marcarDescarga(this.descargandoExcel, p.id, false);
        toastError(this.toast, 'Excel', err, 'No se pudo generar el Excel');
      },
    });
  }

  descargarPdf(p: PedidoListItem): void {
    if (this.estaDescargandoPdf(p.id)) return;
    this.marcarDescarga(this.descargandoPdf, p.id, true);
    this.api.descargarPdfPedido(p.id).subscribe({
      next: (resp) => {
        this.marcarDescarga(this.descargandoPdf, p.id, false);
        this.dispararDescarga(resp, `pedido-${p.id}.pdf`);
      },
      error: (err) => {
        this.marcarDescarga(this.descargandoPdf, p.id, false);
        toastError(this.toast, 'PDF', err, 'No se pudo generar el PDF');
      },
    });
  }

  private marcarDescarga(sig: typeof this.descargandoExcel, id: number, on: boolean): void {
    const next = new Set(sig());
    if (on) next.add(id); else next.delete(id);
    sig.set(next);
  }

  /** Dispara la descarga del blob usando un <a download> efímero. El nombre lo
   *  saca del header Content-Disposition; si no viene, usa el fallback. */
  private dispararDescarga(resp: HttpResponse<Blob>, fallbackName: string): void {
    const blob = resp.body;
    if (!blob) return;
    const filename = this.parsearFilename(resp.headers.get('Content-Disposition')) ?? fallbackName;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  private parsearFilename(contentDisposition: string | null): string | null {
    if (!contentDisposition) return null;
    // Soporta: filename="x.pdf", filename=x.pdf, filename*=UTF-8''x.pdf
    const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(contentDisposition);
    if (utf8?.[1]) return decodeURIComponent(utf8[1].trim());
    const ascii = /filename="?([^";]+)"?/i.exec(contentDisposition);
    return ascii?.[1]?.trim() ?? null;
  }
}
