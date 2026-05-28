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
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Subject, Subscription, debounceTime } from 'rxjs';
import { ConfirmationService, MenuItem, MessageService } from 'primeng/api';
import { AutoCompleteCompleteEvent, AutoCompleteModule } from 'primeng/autocomplete';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { DatePickerModule } from 'primeng/datepicker';
import { DialogModule } from 'primeng/dialog';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { InputMaskModule } from 'primeng/inputmask';
import { InputTextModule } from 'primeng/inputtext';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { SelectModule } from 'primeng/select';
import { SplitButtonModule } from 'primeng/splitbutton';
import { TableLazyLoadEvent, TableModule } from 'primeng/table';
import { TextareaModule } from 'primeng/textarea';
import { ToolbarModule } from 'primeng/toolbar';
import { TooltipModule } from 'primeng/tooltip';
import {
  CrearPedidoRequest,
  FormaPago,
  Localidad,
  PresupuestoListItem,
  Provincia,
} from '../models';
import { MoreMenu } from '../more-menu/more-menu';
import { ShowroomService } from '../showroom.service';
import { toastError } from '../toast.utils';
import { UserChip } from '../user-chip/user-chip';

const DOMINIOS_EMAIL_SUGERIDOS = [
  'gmail.com',
  'hotmail.com',
  'outlook.com',
  'yahoo.com.ar',
  'live.com',
  'icloud.com',
];

/** Placeholder fijo que DUX recibe como apellido/razón social cuando el
 *  pedido se crea a partir de un presupuesto. Distinto del placeholder del
 *  flujo de scan/carrito ("PEDIDO SHOWROOM") para que la operadora distinga
 *  el origen del comprobante en DUX y reemplace por el cliente real al editar. */
const APELLIDO_RAZON_SOCIAL = 'PRESUPUESTO';

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
    AutoCompleteModule,
    ButtonModule,
    CardModule,
    DatePickerModule,
    DialogModule,
    IconFieldModule,
    InputIconModule,
    InputMaskModule,
    InputTextModule,
    ProgressSpinnerModule,
    SelectModule,
    SplitButtonModule,
    TableModule,
    TextareaModule,
    ToolbarModule,
    TooltipModule,
    MoreMenu,
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
  private readonly router = inject(Router);

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

  // ============================================================
  // Dialog "Crear pedido en DUX" desde una fila del historial
  //
  // El operador eligió un presupuesto y quiere transformarlo en pedido.
  // El dialog pre-llena cliente con los datos del presupuesto y pide los
  // campos extra que DUX requiere para crear el comprobante: CUIT,
  // domicilio, provincia, localidad, forma de pago.
  //
  // Al confirmar: carga los items del presupuesto, arma el payload del
  // pedido (precio CON IVA + descuentoPorcentaje por línea — replica lo
  // del presupuesto), POSTea a /pedido-dux, y si DUX devuelve OK marca el
  // presupuesto como `convertidoEnPedidoId=<pedidoId>` para que el listado
  // muestre el pill "→ Pedido #N" en lugar del botón.
  // ============================================================
  readonly mostrarDialogCrearPedido = signal(false);
  /** Presupuesto sobre el que se está creando el pedido. Null cuando el
   *  dialog está cerrado. */
  readonly presupuestoParaPedido = signal<PresupuestoListItem | null>(null);
  readonly cargandoDetallePresupuesto = signal(false);
  readonly enviandoPedido = signal(false);

  // Datos del cliente — pre-llenados desde el presupuesto, editables.
  readonly pedidoNombre = signal('');
  readonly pedidoTelefono = signal('');
  readonly pedidoEmail = signal('');
  readonly pedidoCuit = signal<number | null>(null);
  readonly pedidoRubro = signal<string | null>(null);
  readonly pedidoRubroOtros = signal('');
  readonly pedidoDomicilio = signal('');
  readonly pedidoCodigoProvincia = signal<string | null>(null);
  readonly pedidoIdLocalidad = signal<string | null>(null);
  readonly pedidoObservaciones = signal('');
  readonly pedidoFormaPagoId = signal<number | null>(null);
  readonly sugerenciasEmailPedido = signal<string[]>([]);

  /** Items del presupuesto cargados al abrir el dialog — se usan al armar
   *  el payload del POST /pedido-dux + para calcular el total por forma de
   *  pago en el select. Signal (no var privada) para que los computed que
   *  derivan totales reaccionen al cambiar de presupuesto. */
  readonly itemsDelPresupuesto = signal<{
    sku: string;
    cantidad: number;
    precioConIva: number;
    porcIva: number | null;
    descuentoPorcentaje: number | null;
  }[]>([]);

  /** Subtotal del presupuesto CON IVA — suma de (precioConIva × cantidad ×
   *  (1 - desc/100)) por cada ítem. Es la base que las formas con
   *  `aplicaIva=true` usan para calcular el precio final. */
  readonly subtotalConIvaPedido = computed(() =>
    this.itemsDelPresupuesto().reduce((acc, it) => {
      const factor = 1 - ((it.descuentoPorcentaje ?? 0) / 100);
      return acc + it.precioConIva * it.cantidad * factor;
    }, 0),
  );

  /** Subtotal SIN IVA — divide cada línea por (1 + porcIva/100). Cada item
   *  puede tener su propio IVA (21 / 10.5 / 27), por eso lo dividimos por
   *  línea y no al final con un IVA promedio. */
  readonly subtotalSinIvaPedido = computed(() =>
    this.itemsDelPresupuesto().reduce((acc, it) => {
      const factor = 1 - ((it.descuentoPorcentaje ?? 0) / 100);
      const divisor = 1 + ((it.porcIva ?? 21) / 100);
      return acc + (it.precioConIva / divisor) * it.cantidad * factor;
    }, 0),
  );

  /** Calcula el precio final que paga el cliente con una forma de pago dada.
   *  Misma fórmula que el presupuestador / cotizador:
   *  {@code base / (1 - recargo/100)}, donde base es con-IVA o sin-IVA
   *  según {@code aplicaIva} de la forma. */
  totalParaFormaPago(forma: FormaPago): number {
    const recargo = (forma.recargoPorcentaje ?? 0) / 100;
    const aplicaIva = forma.aplicaIva ?? true;
    const base = aplicaIva ? this.subtotalConIvaPedido() : this.subtotalSinIvaPedido();
    return base / (1 - recargo);
  }

  /** Hardcoded — DUX exige estos campos y son siempre los mismos para todo
   *  pedido del showroom. Se exponen en el dialog como inputs deshabilitados
   *  para que el operador vea exactamente qué se manda a DUX. */
  readonly apellidoRazonSocialFijo = APELLIDO_RAZON_SOCIAL;
  readonly categoriaFiscalFija = 'CONSUMIDOR_FINAL';

  // Catálogos para los selects del dialog. Se cargan lazy al abrir.
  readonly provinciasPedido = signal<Provincia[]>([]);
  readonly localidadesPedido = signal<Localidad[]>([]);
  readonly cargandoLocalidadesPedido = signal(false);
  readonly formasPagoActivas = signal<FormaPago[]>([]);
  private localidadesSub: Subscription | null = null;

  readonly opcionesRubroPedido: { label: string; value: string }[] = [
    { label: 'Bar', value: 'bar' },
    { label: 'Restaurant', value: 'restaurant' },
    { label: 'Catering', value: 'catering' },
    { label: 'Cafetería', value: 'cafeteria' },
    { label: 'Panadería', value: 'panaderia' },
    { label: 'Pastelería', value: 'pasteleria' },
    { label: 'Otros…', value: 'otros' },
  ];

  /** Lista IDs de presupuestos para los que se está cargando el detalle —
   *  permite mostrar spinner solo en la fila que se está abriendo. */
  readonly abriendoCrearPedido = signal<Set<number>>(new Set());

  /** Click en "Crear pedido" de una fila — carga el detalle del presupuesto
   *  (necesario para tomar los items) y abre el dialog con datos
   *  pre-llenados. Si el presupuesto ya está convertido, no debería estar
   *  habilitado el botón, pero igual hacemos guard. */
  abrirCrearPedido(p: PresupuestoListItem): void {
    if (p.convertidoEnPedidoId != null) return;
    if (this.abriendoCrearPedido().has(p.id)) return;

    this.abriendoCrearPedido.update((s) => new Set([...s, p.id]));
    this.api.obtenerDetallePresupuestoComercial(p.id).subscribe({
      next: (det) => {
        this.removerAbriendoPedido(p.id);
        // Pre-llenar form con datos del presupuesto (editables).
        this.presupuestoParaPedido.set(p);
        this.pedidoNombre.set(det.clienteNombre ?? '');
        this.pedidoTelefono.set(det.clienteTelefono ?? '');
        this.pedidoEmail.set(det.clienteEmail ?? '');
        this.pedidoCuit.set(null); // no viene del presupuesto, el operador lo carga
        this.pedidoObservaciones.set(det.observaciones ?? '');
        // Rubro: mapear igual que en CotizadorPage.
        const rubroGuardado = det.rubro ?? null;
        if (!rubroGuardado) {
          this.pedidoRubro.set(null);
          this.pedidoRubroOtros.set('');
        } else if (this.opcionesRubroPedido.some((o) => o.value === rubroGuardado)) {
          this.pedidoRubro.set(rubroGuardado);
          this.pedidoRubroOtros.set('');
        } else {
          this.pedidoRubro.set('otros');
          this.pedidoRubroOtros.set(rubroGuardado);
        }
        // Defaults que no vienen del presupuesto.
        this.pedidoDomicilio.set('');
        this.pedidoCodigoProvincia.set(null);
        this.pedidoIdLocalidad.set(null);
        this.localidadesPedido.set([]);
        this.pedidoFormaPagoId.set(null);

        // Items: el shape persistido es {sku, descripcion, cantidad,
        // precioConIva, porcIva, descuentoPorcentaje}. Para el pedido DUX
        // necesitamos {sku, cantidad, precioUnitario (con IVA),
        // descuentoPorcentaje}.
        this.itemsDelPresupuesto.set(det.items.map((it) => ({
          sku: it.sku,
          cantidad: it.cantidad,
          precioConIva: it.precioConIva,
          // porcIva se usa para calcular el subtotal sin IVA en
          // `subtotalSinIvaPedido` (necesario para las formas con
          // `aplicaIva=false`). Default 21 si el item no lo trae.
          porcIva: it.porcIva,
          descuentoPorcentaje: it.descuentoPorcentaje,
        })));

        // Cargar catálogos en paralelo si no están.
        this.cargarProvinciasSiHaceFalta();
        this.cargarFormasPagoSiHaceFalta();
        this.mostrarDialogCrearPedido.set(true);
      },
      error: (err) => {
        this.removerAbriendoPedido(p.id);
        toastError(this.toast, 'Crear pedido', err,
          'No se pudo cargar el detalle del presupuesto.');
      },
    });
  }

  private removerAbriendoPedido(id: number): void {
    this.abriendoCrearPedido.update((s) => {
      const ns = new Set(s);
      ns.delete(id);
      return ns;
    });
  }

  private cargarProvinciasSiHaceFalta(): void {
    if (this.provinciasPedido().length > 0) return;
    this.api.obtenerProvincias().subscribe({
      next: (lista) => this.provinciasPedido.set(lista),
      error: (err) =>
        toastError(this.toast, 'Provincias', err, 'No se pudieron cargar las provincias'),
    });
  }

  private cargarFormasPagoSiHaceFalta(): void {
    if (this.formasPagoActivas().length > 0) {
      // Default primera forma activa.
      if (this.pedidoFormaPagoId() == null) {
        this.pedidoFormaPagoId.set(this.formasPagoActivas()[0].id);
      }
      return;
    }
    this.api.listarFormasPagoActivas().subscribe({
      next: (lista) => {
        this.formasPagoActivas.set(lista);
        if (lista.length > 0 && this.pedidoFormaPagoId() == null) {
          this.pedidoFormaPagoId.set(lista[0].id);
        }
      },
      error: (err) =>
        console.warn('[formas-pago] no se pudieron cargar:', err),
    });
  }

  cambiarProvinciaPedido(codigo: string | null): void {
    this.localidadesSub?.unsubscribe();
    this.localidadesSub = null;
    this.pedidoCodigoProvincia.set(codigo);
    this.pedidoIdLocalidad.set(null);
    this.localidadesPedido.set([]);
    if (!codigo) {
      this.cargandoLocalidadesPedido.set(false);
      return;
    }
    this.cargandoLocalidadesPedido.set(true);
    this.localidadesSub = this.api.obtenerLocalidades(codigo).subscribe({
      next: (lista) => {
        this.cargandoLocalidadesPedido.set(false);
        this.localidadesPedido.set(lista);
        this.localidadesSub = null;
      },
      error: (err) => {
        this.cargandoLocalidadesPedido.set(false);
        this.localidadesSub = null;
        toastError(this.toast, 'Localidades', err,
          'No se pudieron cargar las localidades');
      },
    });
  }

  onCuitChangePedido(value: string | null | undefined): void {
    const digits = (value ?? '').replace(/\D/g, '');
    this.pedidoCuit.set(digits ? Number(digits) : null);
  }

  onTelefonoChangePedido(value: string | null | undefined): void {
    this.pedidoTelefono.set(value ?? '');
  }

  readonly cuitInputValuePedido = computed(() => {
    const n = this.pedidoCuit();
    return n != null ? String(n) : '';
  });

  readonly telefonoInputValuePedido = computed(() => {
    const t = this.pedidoTelefono();
    return t ? t.replace(/\D/g, '') : '';
  });

  /** Validación mínima para habilitar el botón "Crear en DUX". */
  readonly puedeCrearPedido = computed(() => {
    const cuit = this.pedidoCuit();
    const cuitOk = cuit != null && String(cuit).length === 11;
    const emailOk = /^[^@\s,]+@[^@\s,]+\.[^@\s,]+$/.test(this.pedidoEmail().trim());
    const nombreOk = this.pedidoNombre().trim().length > 0;
    const telOk = this.pedidoTelefono().trim().length > 0;
    const rubro = this.pedidoRubro();
    const rubroOk = !!rubro && (rubro !== 'otros' || this.pedidoRubroOtros().trim().length > 0);
    return cuitOk && emailOk && nombreOk && telOk && rubroOk
      && this.itemsDelPresupuesto().length > 0;
  });

  private rubroFinalPedido(): string {
    const r = this.pedidoRubro();
    if (r === 'otros') return this.pedidoRubroOtros().trim();
    return r ?? '';
  }

  confirmarCrearPedido(): void {
    if (!this.puedeCrearPedido()) {
      this.toast.add({
        severity: 'warn',
        summary: 'Faltan datos',
        detail: 'CUIT 11 dígitos, nombre, teléfono, email y rubro son obligatorios.',
        life: 4000,
      });
      return;
    }
    const p = this.presupuestoParaPedido();
    if (!p) return;

    const cuit = this.pedidoCuit()!;
    const req: CrearPedidoRequest = {
      apellidoRazonSocial: APELLIDO_RAZON_SOCIAL,
      nombre: this.pedidoNombre().trim(),
      categoriaFiscal: 'CONSUMIDOR_FINAL',
      tipoDoc: 'CUIT',
      nroDoc: cuit,
      telefono: this.pedidoTelefono().trim(),
      email: this.pedidoEmail().trim(),
      rubro: this.rubroFinalPedido(),
      domicilio: this.pedidoDomicilio().trim() || undefined,
      codigoProvincia: this.pedidoCodigoProvincia() ?? undefined,
      idLocalidad: this.pedidoIdLocalidad() ?? undefined,
      observaciones: this.pedidoObservaciones().trim() || undefined,
      formaPagoId: this.pedidoFormaPagoId() ?? undefined,
      items: this.itemsDelPresupuesto().map((it) => ({
        sku: it.sku,
        cantidad: it.cantidad,
        // DUX espera precio CON IVA (la lista KT GASTRO está configurada
        // como "incluye IVA"). Mismo comportamiento que showroom-page.
        precioUnitario: it.precioConIva,
        descuentoPorcentaje: it.descuentoPorcentaje ?? undefined,
      })),
    };

    this.enviandoPedido.set(true);
    this.api.crearPedido(req).subscribe({
      next: (res) => {
        this.enviandoPedido.set(false);
        if (res.estado === 'ENVIADO') {
          // Defensive: si por algún motivo el backend devolvió ENVIADO sin
          // pedidoLocalId, no podemos vincular el presupuesto. Avisamos
          // y dejamos al operador resolver (al recargar el listado, el
          // backend ya tiene el pedido pero el vínculo nunca se hizo).
          if (res.pedidoLocalId == null) {
            this.toast.add({
              severity: 'warn',
              summary: 'Pedido creado pero sin id',
              detail: `Pedido enviado a DUX OK pero no recibimos pedidoLocalId. ` +
                `Marca manualmente el presupuesto #${p.id} desde la base.`,
              life: 10000,
            });
            this.mostrarDialogCrearPedido.set(false);
            return;
          }
          // Marcar el presupuesto como convertido y mostrar success.
          this.api.marcarPresupuestoConvertido(p.id, res.pedidoLocalId).subscribe({
            next: () => {
              this.toast.add({
                severity: 'success',
                summary: 'Pedido cargado en DUX',
                detail: `Presupuesto #${p.id} → Pedido #${res.pedidoLocalId}`,
                life: 6000,
              });
              this.mostrarDialogCrearPedido.set(false);
              // Update optimista del listado.
              this.presupuestos.set(this.presupuestos().map((x) =>
                x.id === p.id
                  ? { ...x, convertidoEnPedidoId: res.pedidoLocalId }
                  : x));
            },
            error: (err) => {
              // El pedido se creó en DUX pero no pudimos marcar el
              // presupuesto. No es bloqueante — el operador puede volver
              // a apretar "Crear pedido" igual; si lo hace, se va a
              // duplicar el pedido. Mejor avisamos.
              console.warn('[marcar-convertido] falló:', err);
              this.toast.add({
                severity: 'warn',
                summary: 'Pedido creado pero no quedó vinculado',
                detail: `Pedido #${res.pedidoLocalId} creado OK en DUX. ` +
                  `No se pudo marcar el presupuesto #${p.id} como convertido — ` +
                  `ya NO lo vuelvas a transformar para no duplicar.`,
                life: 12000,
              });
              this.mostrarDialogCrearPedido.set(false);
            },
          });
        } else {
          this.toast.add({
            severity: 'warn',
            summary: 'Pedido pendiente',
            detail: res.mensaje,
            life: 8000,
          });
        }
      },
      error: (err) => {
        this.enviandoPedido.set(false);
        toastError(this.toast, 'Crear pedido', err, 'Error al enviar el pedido a DUX.');
      },
    });
  }

  onCompletarEmailPedido(event: AutoCompleteCompleteEvent): void {
    const query = (event.query ?? '').trim();
    if (!query) {
      this.sugerenciasEmailPedido.set([]);
      return;
    }
    const at = query.indexOf('@');
    if (at < 0) {
      this.sugerenciasEmailPedido.set(DOMINIOS_EMAIL_SUGERIDOS.map((d) => `${query}@${d}`));
      return;
    }
    const localPart = query.substring(0, at);
    const dominioPart = query.substring(at + 1).toLowerCase();
    if (!localPart) {
      this.sugerenciasEmailPedido.set([]);
      return;
    }
    if (dominioPart.includes('.') && !DOMINIOS_EMAIL_SUGERIDOS.some((d) => d.startsWith(dominioPart))) {
      this.sugerenciasEmailPedido.set([]);
      return;
    }
    this.sugerenciasEmailPedido.set(
      DOMINIOS_EMAIL_SUGERIDOS
        .filter((d) => d.startsWith(dominioPart))
        .map((d) => `${localPart}@${d}`),
    );
  }

  /** Botón "Ver pedido" — navega a /pedidos con el id como filtro. */
  irAlPedido(pedidoId: number): void {
    this.router.navigate(['/pedidos'], { queryParams: { id: pedidoId } });
  }

  /** Cleanup al cerrar el dialog: cancela cualquier carga de localidades en
   *  vuelo. Sin esto, si el operador cierra el dialog mientras se cargan,
   *  la suscripción sigue viva y el next setea {@code localidadesPedido}
   *  con datos viejos al reabrir rápido el dialog para otro presupuesto. */
  onCerrarDialogCrearPedido(): void {
    this.localidadesSub?.unsubscribe();
    this.localidadesSub = null;
    this.cargandoLocalidadesPedido.set(false);
  }
}
