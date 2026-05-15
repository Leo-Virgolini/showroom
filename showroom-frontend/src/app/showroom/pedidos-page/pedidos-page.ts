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
import { ActivatedRoute, RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subject, debounceTime } from 'rxjs';
import { MessageService } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { DatePickerModule } from 'primeng/datepicker';
import { DialogModule } from 'primeng/dialog';
import { IconFieldModule } from 'primeng/iconfield';
import { ImageModule } from 'primeng/image';
import { InputIconModule } from 'primeng/inputicon';
import { InputTextModule } from 'primeng/inputtext';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { SelectModule } from 'primeng/select';
import { SkeletonModule } from 'primeng/skeleton';
import { TableLazyLoadEvent, TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { TextareaModule } from 'primeng/textarea';
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
    DialogModule,
    IconFieldModule,
    ImageModule,
    InputIconModule,
    InputTextModule,
    ProgressSpinnerModule,
    SelectModule,
    SkeletonModule,
    TableModule,
    TagModule,
    TextareaModule,
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
  private readonly route = inject(ActivatedRoute);

  readonly busqueda = signal('');
  readonly estado = signal<EstadoPedido | null>(null);
  readonly desde = signal<Date | null>(null);
  readonly hasta = signal<Date | null>(null);
  /** Cuando la ruta trae {@code ?id=X} (deep-link desde /historial), filtramos
   *  la lista a ese pedido y la auto-expandimos. Null = listado normal. */
  readonly pedidoIdFiltro = signal<number | null>(null);

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

  /** IDs de pedido cuyo PDF se está descargando — para deshabilitar el botón. */
  readonly descargandoPdf = signal<Set<number>>(new Set());
  readonly enviandoEmail = signal<Set<number>>(new Set());
  readonly enviandoWhatsapp = signal<Set<number>>(new Set());
  readonly generandoPickit = signal<Set<number>>(new Set());
  readonly anulandoPedido = signal<Set<number>>(new Set());

  /** Pedido que el operador eligió anular — null cuando el dialog está cerrado.
   *  Guardamos la fila completa (no solo el id) para mostrar contexto en el
   *  dialog (cliente, total, si está cargado en DUX, etc.). */
  readonly pedidoAAnular = signal<PedidoListItem | null>(null);
  /** Texto del textarea de motivo dentro del dialog de anulación. */
  readonly motivoAnulacion = signal('');

  /** Filas expandidas (row expansion del p-table). */
  readonly expanded = signal<Record<number, boolean>>({});

  readonly opcionesEstado: { label: string; value: EstadoPedido | null }[] = [
    { label: 'Todos', value: null },
    { label: 'CARGADO EN DUX', value: 'ENVIADO' },
    { label: 'PENDIENTE', value: 'PENDIENTE' },
    { label: 'ERROR', value: 'ERROR' },
    { label: 'ANULADO', value: 'ANULADO' },
  ];

  readonly hayFiltros = computed(
    () =>
      this.pedidoIdFiltro() !== null ||
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
      this.pedidoIdFiltro();
      this.busqueda();
      this.estado();
      this.desde();
      this.hasta();
      this.filtroTrigger$.next();
    });

    // Deep-link desde /historial: ?id=123 → filtrar a ese pedido y auto-expandir.
    // queryParamMap se evalúa una sola vez al montar (suficiente — la pantalla
    // no se re-navega a sí misma con distinto id en el mismo ciclo de vida).
    const idParam = this.route.snapshot.queryParamMap.get('id');
    if (idParam) {
      const n = Number(idParam);
      if (Number.isFinite(n) && n > 0) {
        this.pedidoIdFiltro.set(n);
        this.expanded.set({ [n]: true });
        this.cargarDetalle(n);
      }
    }
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
        id: this.pedidoIdFiltro() ?? undefined,
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
          // cacheados siguen sirviendo si el usuario re-expande). Excepción: si
          // venimos de un deep-link {@code ?id=X}, mantenemos esa fila expandida.
          const filtro = this.pedidoIdFiltro();
          this.expanded.set(filtro != null ? { [filtro]: true } : {});
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
    this.pedidoIdFiltro.set(null);
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

  /** Nombre del cliente real (lo que el operador tipeó en "Nombre y apellido")
   *  para mostrar en la columna Cliente, detalle y modal de anulación. NO
   *  cae a `apellidoRazonSocial`: ese campo es el placeholder fijo "PEDIDO
   *  SHOWROOM" que se manda a DUX como `apellido_razon_social`, no info del
   *  cliente real. Si el operador no cargó nombre, devolvemos null para que
   *  el template muestre "—". */
  nombreCliente(p: { nombre: string | null }): string | null {
    return p.nombre?.trim() || null;
  }

  estadoSeverity(e: EstadoPedido): 'success' | 'warn' | 'danger' | 'secondary' {
    if (e === 'ENVIADO') return 'success';
    if (e === 'PENDIENTE') return 'warn';
    if (e === 'ANULADO') return 'secondary';
    return 'danger';
  }

  /** Etiqueta amigable para el estado del pedido. "ENVIADO" se muestra como
   *  "CARGADO EN DUX" para evitar confundirlo con "despachado al cliente"
   *  (físicamente). El enum del backend se mantiene como ENVIADO para no
   *  romper compatibilidad con datos viejos. */
  estadoLabel(e: EstadoPedido): string {
    if (e === 'ENVIADO') return 'CARGADO EN DUX';
    return e;
  }

  /** Precio sin IVA por unidad. Considera si la forma de pago aplica IVA al
   *  precio guardado: por default (aplicaIva true o null) el {@code precioUnitario}
   *  ya tiene IVA y se divide; si {@code aplicaIva===false} el precio guardado
   *  ya es sin IVA (el cliente paga sin IVA y DUX absorbe). */
  precioSinIva(precioGuardado: number | null, porcIva: number | null, aplicaIva: boolean | null): number | null {
    if (precioGuardado == null) return null;
    if (aplicaIva === false) return precioGuardado;
    if (porcIva == null || porcIva === 0) return precioGuardado;
    return precioGuardado / (1 + porcIva / 100);
  }

  /** Precio con IVA por unidad. Default: el {@code precioUnitario} ya tiene IVA.
   *  Si {@code aplicaIva===false}, hay que sumarle IVA porque está sin (DUX recibe con). */
  precioConIva(precioGuardado: number | null, porcIva: number | null, aplicaIva: boolean | null): number | null {
    if (precioGuardado == null) return null;
    if (aplicaIva !== false) return precioGuardado;
    if (porcIva == null || porcIva === 0) return precioGuardado;
    return precioGuardado * (1 + porcIva / 100);
  }

  /** Subtotal s/IVA por línea — lo que cuenta como base para DUX en una factura con IVA. */
  subtotalSinIva(
    it: { precioUnitario: number | null; porcIva: number | null; cantidad: number | null },
    aplicaIva: boolean | null,
  ): number | null {
    const p = this.precioSinIva(it.precioUnitario, it.porcIva, aplicaIva);
    if (p == null || it.cantidad == null) return null;
    return p * it.cantidad;
  }

  /** Monto total del IVA del pedido. Cuando la forma aplica IVA usa los snapshots
   *  guardados (total - totalSinIva). Cuando NO aplica IVA, el cliente pagó sin
   *  IVA pero DUX igual lo facturó: lo recalculamos per-item porque
   *  {@code total === totalSinIva} en ese caso. */
  ivaTotal(det: PedidoDetalle): number | null {
    if (det.total == null || det.totalSinIva == null) return null;
    if (det.formaPagoAplicaIva === false) {
      const totalDux = this.totalDux(det);
      return totalDux != null ? totalDux - det.total : null;
    }
    return det.total - det.totalSinIva;
  }

  /** Total c/IVA que recibió DUX. En el caso normal coincide con {@code det.total}.
   *  En forma "sin IVA" hay que recalcularlo: el operador absorbe la diferencia. */
  totalDux(det: PedidoDetalle): number | null {
    if (det.formaPagoAplicaIva !== false) return det.total;
    if (!det.items?.length) return det.total;
    let suma = 0;
    for (const it of det.items) {
      const p = this.precioConIva(it.precioUnitario, it.porcIva, false);
      if (p == null) continue;
      suma += p * (it.cantidad ?? 0);
    }
    return suma;
  }

  trackById = (_: number, it: PedidoListItem) => it.id;

  estaDescargandoPdf(id: number): boolean {
    return this.descargandoPdf().has(id);
  }

  estaEnviandoEmail(id: number): boolean {
    return this.enviandoEmail().has(id);
  }

  estaAnulando(id: number): boolean {
    return this.anulandoPedido().has(id);
  }

  /** Un pedido se puede anular salvo que ya esté en estado ANULADO. */
  puedeAnular(p: PedidoListItem): boolean {
    return p.estado !== 'ANULADO';
  }

  /** Abre el diálogo de confirmación de anulación. El operador puede tipear
   *  un motivo opcional. Si el pedido ya estaba CARGADO EN DUX, el dialog
   *  se encarga de mostrar el aviso de cancelación manual. */
  pedirAnular(p: PedidoListItem): void {
    if (!this.puedeAnular(p)) return;
    this.motivoAnulacion.set('');
    this.pedidoAAnular.set(p);
  }

  cancelarAnulacion(): void {
    this.pedidoAAnular.set(null);
    this.motivoAnulacion.set('');
  }

  confirmarAnulacion(): void {
    const p = this.pedidoAAnular();
    if (!p) return;
    if (this.estaAnulando(p.id)) return;
    this.marcarDescarga(this.anulandoPedido, p.id, true);
    const motivo = this.motivoAnulacion().trim() || null;
    this.api.anularPedido(p.id, motivo).subscribe({
      next: (det) => {
        this.marcarDescarga(this.anulandoPedido, p.id, false);
        // Reflejar el nuevo estado en la lista sin recargar todo el listado.
        this.pedidos.set(
          this.pedidos().map((x) =>
            x.id === p.id
              ? { ...x, estado: det.estado, anuladoAt: det.anuladoAt }
              : x,
          ),
        );
        // Refrescar el cache de detalle así si la fila estaba expandida muestra
        // el motivo y el timestamp de anulación.
        this.detalles.set({ ...this.detalles(), [p.id]: det });
        this.pedidoAAnular.set(null);
        this.motivoAnulacion.set('');
        this.toast.add({
          severity: 'success',
          summary: 'Pedido anulado',
          detail: `Pedido #${p.id} marcado como ANULADO.`,
          life: 3500,
        });
      },
      error: (err) => {
        this.marcarDescarga(this.anulandoPedido, p.id, false);
        toastError(this.toast, 'Anular', err, 'No se pudo anular el pedido');
      },
    });
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

  estaEnviandoWhatsapp(id: number): boolean {
    return this.enviandoWhatsapp().has(id);
  }

  reenviarWhatsapp(p: PedidoListItem): void {
    if (this.estaEnviandoWhatsapp(p.id)) return;
    this.marcarDescarga(this.enviandoWhatsapp, p.id, true);
    this.api.reenviarWhatsappPedido(p.id).subscribe({
      next: () => {
        this.marcarDescarga(this.enviandoWhatsapp, p.id, false);
        // El resultado real (SENT / WINDOW_CLOSED / FAILED) llega vía SSE
        // whatsapp-business y se muestra como toast desde app.ts.
        this.toast.add({
          severity: 'info',
          summary: 'WhatsApp encolado',
          detail: 'Subiendo PDF a Meta y mandando…',
          life: 3000,
        });
      },
      error: (err) => {
        this.marcarDescarga(this.enviandoWhatsapp, p.id, false);
        toastError(this.toast, 'WhatsApp', err, 'No se pudo encolar el envío');
      },
    });
  }

  estaGenerandoPickit(id: number): boolean {
    return this.generandoPickit().has(id);
  }

  regenerarPickitExterno(p: PedidoListItem): void {
    if (this.estaGenerandoPickit(p.id)) return;
    this.marcarDescarga(this.generandoPickit, p.id, true);
    this.api.regenerarPickitExterno(p.id).subscribe({
      next: () => {
        this.marcarDescarga(this.generandoPickit, p.id, false);
        // El SSE pickit-externo (toast en app.ts) confirma el path generado.
        this.toast.add({
          severity: 'info',
          summary: 'Pickit externo encolado',
          detail: 'Generando archivo…',
          life: 3000,
        });
      },
      error: (err) => {
        this.marcarDescarga(this.generandoPickit, p.id, false);
        toastError(this.toast, 'Pickit externo', err, 'No se pudo generar el pickit');
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

  private marcarDescarga(sig: typeof this.descargandoPdf, id: number, on: boolean): void {
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
