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
import { ChartModule } from 'primeng/chart';
import { DatePickerModule } from 'primeng/datepicker';
import { DialogModule } from 'primeng/dialog';
import { ImageModule } from 'primeng/image';
import { InputGroupModule } from 'primeng/inputgroup';
import { InputGroupAddonModule } from 'primeng/inputgroupaddon';
import { InputMaskModule } from 'primeng/inputmask';
import { InputTextModule } from 'primeng/inputtext';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { SkeletonModule } from 'primeng/skeleton';
import { TableLazyLoadEvent, TableModule } from 'primeng/table';
import { TabsModule } from 'primeng/tabs';
import { TagModule } from 'primeng/tag';
import { ToolbarModule } from 'primeng/toolbar';
import { TooltipModule } from 'primeng/tooltip';
import {
  ConversionProducto,
  EstadisticaProducto,
  EstadisticasHistorial,
  FormaPago,
  SesionDetalle,
  SesionListItem,
} from '../models';
import { precioPorForma, precioSinIva } from '../precio-referencia.util';
import { PrecioPerfilService } from '../precio-perfil.service';
import { dispararDescargaBlob } from '../download.utils';
import { ShowroomService } from '../showroom.service';
import { toastError } from '../toast.utils';
import { TopActions } from '../top-actions/top-actions';

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
    ChartModule,
    DatePickerModule,
    DialogModule,
    ImageModule,
    InputGroupModule,
    InputGroupAddonModule,
    InputMaskModule,
    InputTextModule,
    ProgressSpinnerModule,
    SkeletonModule,
    TableModule,
    TabsModule,
    TagModule,
    ToolbarModule,
    TooltipModule,
    TopActions,
  ],
  templateUrl: './historial-page.html',
  styleUrl: './historial-page.scss',
})
export class HistorialPage {
  private readonly api = inject(ShowroomService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly precioPerfil = inject(PrecioPerfilService);

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

  /** Formas de pago activas — para calcular el "precio efectivo" (forma
   *  destacada) de cada ítem del detalle, igual que en el scan/visor. */
  readonly formasPagoActivas = this.precioPerfil.formasPago;

  readonly hayFiltros = computed(
    () =>
      this.busqueda().trim().length > 0 ||
      this.desde() !== null ||
      this.hasta() !== null,
  );

  private readonly filtroTrigger$ = new Subject<void>();

  // ============================================================
  // Charts: top productos más escaneados / comprados
  // ============================================================
  readonly cargandoStats = signal(false);
  readonly stats = signal<EstadisticasHistorial | null>(null);

  /** Datasets de Chart.js para el top escaneados. Memoizado con computed —
   *  se recalcula sólo cuando cambia {@code stats}. */
  readonly chartEscaneadosData = computed(() => this.buildChartData(
    this.stats()?.topEscaneados ?? [],
    'Veces escaneado',
    'rgba(255, 134, 28, 0.7)',  // naranja KT
    'rgba(255, 134, 28, 1)',
  ));

  readonly chartCompradosData = computed(() => this.buildChartData(
    this.stats()?.topComprados ?? [],
    'Unidades vendidas',
    'rgba(126, 186, 0, 0.7)',  // verde KT
    'rgba(126, 186, 0, 1)',
  ));

  /** % de conversión global formateado (ej: 38.5). Null si no hay sesiones
   *  finalizadas todavía (división por cero). */
  readonly conversionGlobalPct = computed<number | null>(() => {
    const t = this.stats()?.tasaConversion;
    if (!t || t.sesionesFinalizadas === 0) return null;
    return Math.round((t.sesionesConPedido / t.sesionesFinalizadas) * 1000) / 10;
  });

  /** Lista para la tabla de conversión por producto. */
  readonly topConversion = computed<ConversionProducto[]>(
    () => this.stats()?.topConversion ?? [],
  );

  /** Altura dinámica de los charts según cantidad de barras — evita el espacio
   *  vacío grande que dejaba la altura fija cuando había pocos items. Cada
   *  barra ocupa ~3rem (con padding), mínimo 8rem para que se vea decente
   *  con 1-2 items + sumamos 2rem fijos para el eje X y respiro inferior. */
  altoChart(items: number): string {
    return `${Math.max(8, items * 3 + 2)}rem`;
  }

  /** Opciones comunes a ambos charts: barras horizontales, tooltip con
   *  descripción del producto, escala entera (no decimales en cantidades). */
  readonly chartOptions = {
    indexAxis: 'y' as const,
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          title: (items: { dataIndex: number }[]) => {
            const idx = items[0]?.dataIndex ?? -1;
            const top = this.chartContextActual?.[idx];
            return top ? `${top.sku} — ${top.descripcion ?? '—'}` : '';
          },
        },
      },
    },
    scales: {
      x: { ticks: { precision: 0 } },
    },
  };

  /** Buffer del último array consumido por el tooltip — Chart.js no expone
   *  el item original en el callback, así que lo mantenemos a mano. Se
   *  actualiza en {@code buildChartData}. */
  private chartContextActual: EstadisticaProducto[] | null = null;

  private buildChartData(
    top: EstadisticaProducto[],
    label: string,
    bg: string,
    border: string,
  ) {
    // Guardamos el contexto para el tooltip — last write wins, ambos charts
    // se renderizan en el mismo tick y cada uno setea su propio contexto.
    this.chartContextActual = top;
    return {
      labels: top.map(p => p.sku),
      datasets: [{
        label,
        data: top.map(p => p.total),
        backgroundColor: bg,
        borderColor: border,
        borderWidth: 1,
      }],
    };
  }

  constructor() {
    this.filtroTrigger$
      .pipe(debounceTime(300), takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.first.set(0);
        this.cargar(0, this.pageSize());
        this.cargarStats();
      });

    // Guard contra doble request inicial: el effect corre la primera vez al
    // mount (los signals tienen valor inicial) y `onLazyLoad` del p-table
    // también dispara. Si no skipeamos la primera, se hacen 2 cargas idénticas.
    let filtrosInicializados = false;
    effect(() => {
      this.busqueda();
      this.desde();
      this.hasta();
      if (!filtrosInicializados) {
        filtrosInicializados = true;
        return;
      }
      this.filtroTrigger$.next();
    });

    this.cargarStats();

    // Formas de pago y rubros sin IVA — necesarios para el "precio efectivo"
    // (precio de la forma destacada por perfil) en el detalle de cada sesión.
    this.precioPerfil.cargar();
  }

  private cargarStats(): void {
    this.cargandoStats.set(true);
    const desde = this.desde();
    const hasta = this.hasta();
    this.api.obtenerEstadisticasHistorial({
      desde: desde ? desde.toISOString() : undefined,
      hasta: hasta ? this.endOfDay(hasta).toISOString() : undefined,
      topN: 10,
    }).subscribe({
      next: (s) => {
        this.cargandoStats.set(false);
        this.stats.set(s);
      },
      error: (err) => {
        this.cargandoStats.set(false);
        // Silencioso — los charts no son críticos para la operativa del historial.
        console.warn('[historial] no se pudieron cargar las estadísticas:', err);
      },
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

  /** Saca el IVA del precio para mostrarlo s/IVA, igual que en el detalle de
   *  pedidos. Alias de la función pura compartida del util. */
  protected readonly precioSinIva = precioSinIva;

  /** True si el rubro cotiza sin IVA (perfil maquinaria). */
  rubroCotizaSinIva(rubro: string | null | undefined): boolean {
    return this.precioPerfil.rubroCotizaSinIva(rubro);
  }

  /** Perfil (recargo + aplicaIva) de una forma según el rubro del producto:
   *  maquinaria usa los campos *Maquinaria; menaje los normales. */
  perfilForma(
    forma: FormaPago,
    esMaquinaria: boolean,
  ): { recargoPorcentaje: number | null; aplicaIva: boolean | null } {
    return this.precioPerfil.perfilForma(forma, esMaquinaria);
  }

  /** Forma de pago destacada ("Precio ref.") según el perfil del rubro: la
   *  primera (orden asc) marcada, o null si no hay ninguna. */
  formaDestacada(esMaquinaria: boolean): FormaPago | null {
    return this.precioPerfil.formaDestacada(esMaquinaria);
  }

  /** Precio "efectivo" de un ítem del detalle = precio con la forma destacada
   *  del perfil (igual que el precio destacado del scan/visor). Si no hay forma
   *  destacada, cae al precio de lista según rubro. */
  precioEfectivo(item: {
    precioConIva: number | null;
    porcIva: number | null;
    rubro?: string | null;
  }): number {
    const esMaq = this.rubroCotizaSinIva(item.rubro);
    const forma = this.formaDestacada(esMaq);
    if (forma) return precioPorForma(item.precioConIva, item.porcIva, this.perfilForma(forma, esMaq));
    // fallback sin forma destacada: precio de lista según rubro
    return esMaq
      ? (this.precioSinIva(item.precioConIva, item.porcIva) ?? 0)
      : (item.precioConIva ?? 0);
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

  /** Valor digit-only para el p-inputMask del teléfono cuando el modo es whatsapp.
   *  Limpia el signal de cualquier char que no sea dígito por si quedó algún
   *  hyphen legado. */
  readonly telefonoInputValue = computed(() => this.destinatarioInput().replace(/\D/g, ''));

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

  // =====================================================
  // Descarga directa del PDF de "productos vistos no comprados".
  // Aplica a cualquier sesión finalizada con items (con o sin pedido): el
  // backend filtra lo comprado cuando hay un pedido asociado.
  // =====================================================

  /** Sesiones en las que se está generando el PDF (loading del botón). */
  readonly descargandoPdf = signal<Set<number>>(new Set());

  estaDescargandoPdf(id: number): boolean {
    return this.descargandoPdf().has(id);
  }

  /** True para sesiones finalizadas con al menos un item escaneado. */
  puedeDescargarPdf(s: SesionListItem): boolean {
    return s.finalizadaAt != null && s.cantidadEscaneados > 0;
  }

  descargarPdfSesion(s: SesionListItem, event: Event): void {
    event.stopPropagation();
    if (!this.puedeDescargarPdf(s) || this.estaDescargandoPdf(s.id)) return;
    this.marcarDescarga(s.id, true);
    this.api.descargarPdfSesion(s.id).subscribe({
      next: (resp) => {
        this.marcarDescarga(s.id, false);
        dispararDescargaBlob(resp, `items-de-interes-sesion-${s.id}.pdf`);
      },
      error: (err) => {
        this.marcarDescarga(s.id, false);
        // 404 = "compró todo lo que vio" — caso esperado, no error técnico.
        // El body de error viene como Blob (responseType:'blob'), pero el
        // status alcanza para distinguirlo sin parsearlo.
        if (err?.status === 404) {
          this.toast.add({
            severity: 'info',
            summary: 'No hay PDF para esta sesión',
            detail: 'El cliente compró todo lo que vio — no quedan productos no comprados.',
            life: 5000,
          });
          return;
        }
        toastError(this.toast, 'PDF', err, 'No se pudo generar el PDF');
      },
    });
  }

  private marcarDescarga(id: number, on: boolean): void {
    const next = new Set(this.descargandoPdf());
    if (on) next.add(id); else next.delete(id);
    this.descargandoPdf.set(next);
  }

  trackById = (_: number, it: SesionListItem) => it.id;
}
