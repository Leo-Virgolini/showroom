import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ViewChild,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subject, debounceTime } from 'rxjs';
import { MessageService } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { ChartModule, UIChart } from 'primeng/chart';
import { DatePickerModule } from 'primeng/datepicker';
import { DialogModule } from 'primeng/dialog';
import { ImageModule } from 'primeng/image';
import { InputGroupModule } from 'primeng/inputgroup';
import { InputGroupAddonModule } from 'primeng/inputgroupaddon';
import { InputMaskModule } from 'primeng/inputmask';
import { InputTextModule } from 'primeng/inputtext';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { SelectModule } from 'primeng/select';
import { SkeletonModule } from 'primeng/skeleton';
import { TableLazyLoadEvent, TableModule } from 'primeng/table';
import { TabsModule } from 'primeng/tabs';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import {
  ConversionProducto,
  EstadisticaProducto,
  EstadisticasHistorial,
  SesionDetalle,
  SesionListItem,
} from '../models';
import { precioSinIva } from '../precio-referencia.util';
import { PrecioPerfilService } from '../precio-perfil.service';
import { dispararDescargaBlob } from '../download.utils';
import { ShowroomService } from '../showroom.service';
import { finDelDia, marcarEnSet, sortDesdeLazyLoad } from '../tabla.utils';
import { toastError } from '../toast.utils';
import { PageHeader } from '../page-header/page-header';

@Component({
  selector: 'app-historial-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    FormsModule,
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
    SelectModule,
    SkeletonModule,
    TableModule,
    TabsModule,
    TagModule,
    TooltipModule,
    RouterLink,
    PageHeader,  ],
  templateUrl: './historial-page.html',
  styleUrl: './historial-page.scss',
})
export class HistorialPage {
  private readonly api = inject(ShowroomService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly precioPerfil = inject(PrecioPerfilService);
  private readonly route = inject(ActivatedRoute);

  readonly busqueda = signal('');
  readonly desde = signal<Date | null>(null);
  readonly hasta = signal<Date | null>(null);

  readonly cargando = signal(false);
  readonly sesiones = signal<SesionListItem[]>([]);
  readonly total = signal(0);
  readonly pageSize = signal(50);
  readonly first = signal(0);
  /** Campo de orden actual — coincide con los keys de `SORT_SESIONES` del backend. */
  readonly sortField = signal<string>('iniciadaAt');
  readonly sortOrder = signal<'asc' | 'desc'>('desc');

  /** Cache de detalles ya obtenidos: id → SesionDetalle. */
  readonly detalles = signal<Record<number, SesionDetalle>>({});
  readonly cargandoDetalle = signal<Set<number>>(new Set());
  /** Filas expandidas. */
  readonly expanded = signal<Record<number, boolean>>({});

  /** Id de la sesión a destacar/resaltar en la tabla por deep-link
   *  (`/historial?sesion=N`). null = ninguna destacada. La fila se antepone a
   *  la lista visible si no está en la página actual, se expande y se le hace
   *  scroll. */
  readonly sesionDestacadaId = signal<number | null>(null);

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

  // Refs a los dos charts para forzar su re-medición tras cambiar el topN
  // (ver reinicializarCharts). Pueden ser undefined si no hay datos (no se
  // renderiza el <p-chart>).
  @ViewChild('chartEscaneados') private escaneadosChart?: UIChart;
  @ViewChild('chartComprados') private compradosChart?: UIChart;

  /** Cantidad de productos a mostrar en los 3 rankings (escaneados, comprados,
   *  conversión). El backend aplica el mismo `topN` a las tres secciones. Se
   *  persiste en localStorage para recordar la preferencia entre visitas. */
  static readonly OPCIONES_TOP_N = [10, 20, 30, 50] as const;
  private static readonly TOP_N_KEY = 'historial:statsTopN';
  readonly opcionesTopN: number[] = [...HistorialPage.OPCIONES_TOP_N];
  readonly topN = signal<number>(HistorialPage.leerTopNGuardado());

  /** Lee el topN de localStorage saneándolo contra las opciones válidas; ante
   *  cualquier valor ausente o corrupto cae al default (10). */
  private static leerTopNGuardado(): number {
    const raw = Number(localStorage.getItem(HistorialPage.TOP_N_KEY));
    return (HistorialPage.OPCIONES_TOP_N as readonly number[]).includes(raw)
      ? raw
      : 10;
  }

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

  /** % de sesiones que terminaron en presupuesto (categoría propia, distinta del
   *  pedido). Null si no hay sesiones finalizadas en el rango, o si no hubo
   *  ninguna conversión a presupuesto (oculta la línea en vez de mostrar "+0%"
   *  o NaN). */
  readonly conversionPresupuestoPct = computed<number | null>(() => {
    const t = this.stats()?.tasaConversion;
    if (!t || t.sesionesFinalizadas === 0) return null;
    if (!t.sesionesConPresupuesto) return null;
    return Math.round((t.sesionesConPresupuesto / t.sesionesFinalizadas) * 1000) / 10;
  });

  /** Lista para la tabla de conversión por producto. */
  readonly topConversion = computed<ConversionProducto[]>(
    () => this.stats()?.topConversion ?? [],
  );

  /** Altura dinámica de los charts según cantidad de barras — evita el espacio
   *  vacío grande que dejaba la altura fija cuando había pocos items. Cada
   *  barra ocupa ~1.4rem + 2rem fijos para el eje X y respiro inferior. Piso de
   *  8rem para que con 1-2 items no se vea ridículo; techo de 48rem para que
   *  con muchos productos (top 50 → sin techo daría ~152rem) el chart no ocupe
   *  media pantalla ni empuje la leyenda de SKUs miles de px hacia abajo — a
   *  partir del techo las barras se comprimen, aceptable en un ranking largo. */
  altoChart(items: number): string {
    return `${Math.min(48, Math.max(8, items * 1.4 + 2))}rem`;
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
          // El array de productos viaja dentro del propio dataset (ver
          // buildChartData), así cada chart resuelve su tooltip contra SUS
          // datos — sin buffer compartido entre escaneados y comprados.
          title: (items: { dataIndex: number; dataset: { productos?: EstadisticaProducto[] } }[]) => {
            const item = items[0];
            const p = item ? item.dataset.productos?.[item.dataIndex] : undefined;
            return p ? `${p.sku} — ${p.descripcion ?? '—'}` : '';
          },
        },
      },
    },
    scales: {
      x: { ticks: { precision: 0 } },
    },
  };

  private buildChartData(
    top: EstadisticaProducto[],
    label: string,
    bg: string,
    border: string,
  ) {
    return {
      labels: top.map(p => p.sku),
      datasets: [{
        label,
        data: top.map(p => p.total),
        // Adjuntamos los productos al dataset para que el tooltip los lea desde
        // su propio contexto — sin estado compartido entre los dos charts.
        productos: top,
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

    // Deep-link: /historial?sesion=N muestra esa sesión en la propia tabla,
    // expandida y destacada (no en un modal). Nos suscribimos a queryParams (no
    // solo snapshot) para que reaccione si se navega entre distintos ids sin
    // recargar.
    this.route.queryParamMap
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((params) => {
        const raw = params.get('sesion');
        const id = raw != null ? Number(raw) : NaN;
        if (Number.isInteger(id) && id > 0) {
          this.destacarSesion(id);
        } else {
          this.sesionDestacadaId.set(null);
        }
      });
  }

  /** Carga la sesión por id, la asegura visible en la tabla (anteponiéndola si
   *  no está en la página actual), la expande y la resalta + scrollea. La
   *  sesión puede no estar en la página lazy actual, por eso se carga por id. */
  private destacarSesion(id: number): void {
    this.api.obtenerSesion(id).subscribe({
      next: (det) => {
        // Cachear el detalle igual que cargarDetalle, para el row-expansion.
        this.detalles.set({ ...this.detalles(), [id]: det });

        // Asegurar que la sesión esté en la lista visible. Si no, anteponer un
        // item de listado construido desde el detalle. estadoPedido y creadoPor
        // no vienen en el detalle → defaults; cantidadEscaneados = #items.
        if (!this.sesiones().some((s) => s.id === id)) {
          const item: SesionListItem = {
            id: det.id,
            nombre: det.nombre,
            iniciadaAt: det.iniciadaAt,
            finalizadaAt: det.finalizadaAt,
            pedidoId: det.pedidoId,
            estadoPedido: null,
            cantidadEscaneados: det.items.length,
            creadoPor: null,
          };
          this.sesiones.set([item, ...this.sesiones()]);
        }

        // Expandir la fila (mismo mecanismo que toggleRow / estaExpandido).
        this.expanded.set({ ...this.expanded(), [id]: true });

        // Resaltar + scrollear una vez que el DOM esté pintado.
        this.sesionDestacadaId.set(id);
        setTimeout(() => {
          document
            .getElementById(`sesion-row-${id}`)
            ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
      },
      error: (err) => {
        this.sesionDestacadaId.set(null);
        toastError(this.toast, 'Sesión', err, 'No se pudo cargar la sesión');
      },
    });
  }

  /** Cambia la cantidad de productos de los rankings: persiste la preferencia
   *  y recarga las estadísticas con el nuevo límite (afecta a las 3 secciones
   *  a la vez, ya que comparten la misma respuesta). No-op si no cambió. */
  cambiarTopN(n: number): void {
    if (n === this.topN()) return;
    this.topN.set(n);
    localStorage.setItem(HistorialPage.TOP_N_KEY, String(n));
    this.cargarStats();
  }

  private cargarStats(): void {
    this.cargandoStats.set(true);
    const desde = this.desde();
    const hasta = this.hasta();
    this.api.obtenerEstadisticasHistorial({
      desde: desde ? desde.toISOString() : undefined,
      hasta: hasta ? finDelDia(hasta).toISOString() : undefined,
      topN: this.topN(),
    }).subscribe({
      next: (s) => {
        this.cargandoStats.set(false);
        this.stats.set(s);
        this.reinicializarCharts();
      },
      error: (err) => {
        this.cargandoStats.set(false);
        // Silencioso — los charts no son críticos para la operativa del historial.
        console.warn('[historial] no se pudieron cargar las estadísticas:', err);
      },
    });
  }

  /** Chart.js mide el alto del contenedor al (re)crearse. Cuando cambia el topN,
   *  el alto del div (altoChart) y los datos cambian en el mismo ciclo, así que
   *  a veces mide un layout transitorio y las barras quedan apretadas arriba con
   *  un hueco enorme abajo. Reinicializamos los charts en un macrotask —tras el
   *  CD y con la altura final ya aplicada al DOM— replicando la medición correcta
   *  que ocurre naturalmente al refrescar con F5. */
  private reinicializarCharts(): void {
    setTimeout(() => {
      this.escaneadosChart?.reinit();
      this.compradosChart?.reinit();
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
      .listarSesiones({
        q: this.busqueda(),
        desde: desde ? desde.toISOString() : undefined,
        hasta: hasta ? finDelDia(hasta).toISOString() : undefined,
        page,
        size,
        sortField: this.sortField(),
        sortOrder: this.sortOrder(),
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

  /** Marca de maquinaria (rubro de la lista configurable que cotiza sin IVA) —
   *  mismo criterio que la tabla de productos. Se usa para el ícono pi-wrench. */
  esRubroMaquinaria(rubro: string | null | undefined): boolean {
    return this.precioPerfil.rubroCotizaSinIva(rubro);
  }

  /** Precio de REFERENCIA de un ítem del detalle = precio con la forma destacada
   *  del perfil (igual que el scan/visor). Delega en el servicio compartido; el
   *  ítem guarda el precio como `precioConIva`, así que se mapea al shape del
   *  servicio (con el sin-IVA derivado para el fallback de maquinaria). */
  precioReferencia(item: {
    precioConIva: number | null;
    porcIva: number | null;
    rubro?: string | null;
  }): number {
    return this.precioPerfil.precioReferencia({
      pvpKtGastroConIva: item.precioConIva,
      pvpKtGastroSinIva: this.precioSinIva(item.precioConIva, item.porcIva),
      porcIva: item.porcIva,
      rubro: item.rubro,
    });
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
    marcarEnSet(this.descargandoPdf, s.id, true);
    this.api.descargarPdfSesion(s.id).subscribe({
      next: (resp) => {
        marcarEnSet(this.descargandoPdf, s.id, false);
        dispararDescargaBlob(resp, `items-de-interes-sesion-${s.id}.pdf`);
      },
      error: (err) => {
        marcarEnSet(this.descargandoPdf, s.id, false);
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

  trackById = (_: number, it: SesionListItem) => it.id;
}
