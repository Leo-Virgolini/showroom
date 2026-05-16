import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  HostListener,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { EMPTY, Subject, Subscription } from 'rxjs';
import { catchError, debounceTime, groupBy, mergeMap, switchMap, tap } from 'rxjs/operators';
import { ConfirmationService, MessageService } from 'primeng/api';
import { AutoCompleteCompleteEvent, AutoCompleteModule } from 'primeng/autocomplete';
import { AvatarModule } from 'primeng/avatar';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { CheckboxModule } from 'primeng/checkbox';
import { DialogModule } from 'primeng/dialog';
import { OverlayBadgeModule } from 'primeng/overlaybadge';
import { IconFieldModule } from 'primeng/iconfield';
import { ImageModule } from 'primeng/image';
import { InputGroupModule } from 'primeng/inputgroup';
import { InputGroupAddonModule } from 'primeng/inputgroupaddon';
import { InputIconModule } from 'primeng/inputicon';
import { InputMaskModule } from 'primeng/inputmask';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { MeterGroupModule } from 'primeng/metergroup';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { SelectModule } from 'primeng/select';
import { SplitterModule } from 'primeng/splitter';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { TextareaModule } from 'primeng/textarea';
import { ToolbarModule } from 'primeng/toolbar';
import { TooltipModule } from 'primeng/tooltip';
import { AuthService } from '../../auth/auth.service';
import { BackendStatusService } from '../backend-status.service';
import { CarritoItem, CatalogoItem, CategoriaFiscal, EscalaDescuento, FormaPago, Localidad, Provincia, ScanResult, SesionShowroom } from '../models';
import { ShowroomService } from '../showroom.service';
import { SyncStateService } from '../sync-state.service';
import { toastError } from '../toast.utils';

/**
 * Datos del cliente que el vendedor completa al cerrar el pedido.
 * El `apellido_razon_social` que recibe DUX es siempre el placeholder fijo
 * "PEDIDO SHOWROOM" (la operadora lo asocia con el cliente real al editar el
 * comprobante), así que no es input. categoriaFiscal y tipoDoc también van
 * hardcodeadas. El CUIT es la clave que conecta el pedido con el cliente real.
 */
interface DatosCliente {
  nroDoc: number | null;
  /** Nombre y apellido (o razón social) del cliente. Se manda a DUX en el campo
   * `nombre` del payload de /pedido/nuevopedido y se muestra en la carátula del
   * PDF de presupuesto y en la columna Cliente del listado. Opcional: si queda
   * vacío, la columna Cliente muestra "—". */
  nombre: string;
  telefono: string;
  email: string;
  domicilio: string;
  codigoProvincia: string | null;
  idLocalidad: string | null;
  /** Observaciones del pedido — se persisten en `pedido_showroom.observaciones` y
   * también se envían a DUX en el campo `observaciones` del comprobante. */
  observaciones: string;
}

const CLIENTE_VACIO: DatosCliente = {
  nroDoc: null,
  nombre: '',
  telefono: '',
  email: '',
  domicilio: '',
  codigoProvincia: null,
  idLocalidad: null,
  observaciones: '',
};

/** Dominios sugeridos al tipear el email. Orden = popularidad esperada en AR. */
const DOMINIOS_EMAIL_SUGERIDOS = [
  'gmail.com',
  'hotmail.com',
  'outlook.com',
  'yahoo.com.ar',
  'live.com',
  'icloud.com',
];

/** Nombre con el que se carga todo pedido del showroom — la operadora lo
 * sobrescribe en DUX al asociar el CUIT con el cliente real. */
const APELLIDO_RAZON_SOCIAL = 'PEDIDO SHOWROOM';

/**
 * Re-ordena una lista para que los items cuyo nombre empieza con `query` aparezcan
 * antes que los que solo lo contienen. Mantiene el orden relativo dentro de cada
 * grupo. Útil para que al tipear "oliv" en el select aparezcan OLIVERA / OLIVIERA
 * antes que NICANOR OLIVERA / BOLIVAR.
 */
function ordenarPorPrefijo<T>(items: T[], query: string, getNombre: (it: T) => string): T[] {
  const q = query.toLowerCase().trim();
  if (!q) return items;
  const starts: T[] = [];
  const contains: T[] = [];
  for (const it of items) {
    const n = getNombre(it).toLowerCase();
    if (n.startsWith(q)) starts.push(it);
    else if (n.includes(q)) contains.push(it);
  }
  return [...starts, ...contains];
}

@Component({
  selector: 'app-showroom-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    FormsModule,
    RouterLink,
    AutoCompleteModule,
    AvatarModule,
    ButtonModule,
    CardModule,
    CheckboxModule,
    DialogModule,
    IconFieldModule,
    ImageModule,
    InputGroupModule,
    InputGroupAddonModule,
    InputIconModule,
    InputMaskModule,
    InputNumberModule,
    InputTextModule,
    MeterGroupModule,
    OverlayBadgeModule,
    ProgressSpinnerModule,
    SelectModule,
    SplitterModule,
    TableModule,
    TagModule,
    TextareaModule,
    ToolbarModule,
    TooltipModule,
  ],
  templateUrl: './showroom-page.html',
  styleUrl: './showroom-page.scss',
})
export class ShowroomPage implements AfterViewInit {
  private readonly api = inject(ShowroomService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly toast = inject(MessageService);
  private readonly confirmationService = inject(ConfirmationService);
  private readonly syncState = inject(SyncStateService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly backendStatus = inject(BackendStatusService);

  readonly scanInput = viewChild<ElementRef<HTMLInputElement>>('scanInput');

  readonly skuInput = signal('');
  readonly cantidadInput = signal(1);
  readonly ultimoScan = signal<ScanResult | null>(null);
  readonly cargandoScan = signal(false);
  /** Resultados de búsqueda por descripción cuando no hay match exacto por
   *  SKU/EAN. Se muestra como lista clickable; al elegir uno se carga el
   *  producto via `seleccionarResultado(sku)`. */
  readonly resultadosBusqueda = signal<CatalogoItem[]>([]);
  /** Total de matches en el backend — puede ser mayor que la lista visible
   *  si todavía no se cargaron todas las páginas. */
  readonly totalResultadosBusqueda = signal(0);
  /** Última query usada para la búsqueda — necesaria para pedir más páginas. */
  private readonly busquedaQuery = signal('');
  /** Última página cargada (0-indexed). */
  private readonly paginaResultados = signal(0);
  /** Loading state del botón "Cargar más" (separado de cargandoScan). */
  readonly cargandoMasResultados = signal(false);

  /** Tamaño de cada página de resultados. */
  private readonly BUSQUEDA_PAGE_SIZE = 50;

  /** Secuencia incremental para descartar respuestas obsoletas. Si el
   *  operador dispara un scan/búsqueda nuevo antes de que termine el
   *  anterior, solo la última respuesta actualiza la UI — así evitamos
   *  que un request lento "pise" al rápido al volver fuera de orden. */
  private scanSeq = 0;
  /** Estado del carrito. Vive en el backend (single source of truth) y se
   *  hidrata en el constructor + se sincroniza vía SSE `carrito-updated`.
   *  Las mutaciones siempre van por HTTP — nunca se modifica este signal a
   *  mano, salvo la asignación inicial al hidratar y los updates optimistas
   *  de cantidad (que después se reconcilian con el state del backend). */
  readonly carrito = signal<CarritoItem[]>([]);
  /** Sesión de atención al cliente — la mantiene el backend (global, como el
   *  carrito) y se sincroniza vía SSE `sesion-updated`. Cuando no hay activa
   *  todos los campos son null. */
  readonly sesionActiva = signal<SesionShowroom>({
    id: null, nombre: null, iniciadaAt: null, finalizadaAt: null,
    pedidoId: null, cantidadEscaneados: 0,
  });
  readonly haySesionActiva = computed(() => this.sesionActiva().id != null);
  /** Iniciales del nombre del cliente activo — máx. 2 letras para el avatar.
   *  "María Pérez" → "MP" / "Juan" → "J" / "" → "?". */
  readonly inicialesCliente = computed(() => {
    const nombre = this.sesionActiva().nombre?.trim() ?? '';
    if (!nombre) return '?';
    return (
      nombre
        .split(/\s+/)
        .slice(0, 2)
        .map((p) => p.charAt(0).toUpperCase())
        .join('') || '?'
    );
  });
  /** Modal "Nuevo cliente" — visible/hidden + nombre tipeado. */
  readonly mostrarDialogoNuevoCliente = signal(false);
  readonly nombreNuevoCliente = signal('');
  readonly iniciandoSesion = signal(false);
  /** Updates de cantidad — debounceadas por SKU para que clickear +/- rápido
   *  no dispare un PATCH por click. El último valor por SKU dentro del
   *  intervalo es el que viaja al backend. La suscripción se arma en el
   *  constructor. */
  private readonly cantidadUpdates$ = new Subject<{ sku: string; cantidad: number }>();
  readonly refrescando = signal(false);
  /** Refresh on-demand del producto recién scaneado — distinto de `refrescando`
   *  que es para el carrito completo. */
  readonly refrescandoScan = signal(false);
  readonly enviando = signal(false);

  readonly mostrarConfirmacion = signal(false);
  readonly cliente = signal<DatosCliente>({ ...CLIENTE_VACIO });

  /** Lista de sugerencias actual del autocomplete del email — se actualiza
   *  dinámicamente con cada keystroke (ver onCompletarEmail). */
  readonly sugerenciasEmail = signal<string[]>([]);

  readonly mostrarSyncDialog = signal(false);
  readonly forzarSyncCompleto = signal(false);

  /** Dialog "QR para celular" — muestra dos imágenes pre-generadas:
   *  WiFi (auto-conexión) y Visor (pantalla de precios). Ambas viven en
   *  {@code public/} ({@code conexion-wifi.png} y {@code qr-precios.png}). */
  readonly mostrarDialogVisor = signal(false);

  /** Dialog de reseña en Google que aparece después de cada pedido confirmado.
   *  Muestra una imagen estática con el QR ya pre-generado
   *  ({@code public/opinion-google.png}). */
  readonly mostrarDialogReview = signal(false);

  /** Si está activo, al apretar "Enviar a DUX" refrescamos stock+precio
   *  contra DUX como última validación antes de crear el pedido. Default
   *  false (más rápido). El operador puede activarlo si quiere asegurarse
   *  contra DUX en el momento de enviar (suma ~7s por item). */
  readonly verificarStockAlEnviar = signal(false);

  /** Items del carrito que quedaron con stock insuficiente al re-validar
   *  contra DUX antes de enviar el pedido. Se muestran en un diálogo
   *  modal — no en un toast — para que el operador tenga tiempo de leer
   *  la lista completa y decidir qué ajustar. */
  readonly excedidosStock = signal<{
    sku: string;
    descripcion: string | null;
    cantidadPedida: number;
    stockDisponible: number;
  }[]>([]);
  readonly mostrarDialogExcedidos = signal(false);

  /** Estado de DUX/sync — fuente de verdad central, propagada vía SSE. */
  readonly health = this.syncState.health;

  readonly screenLg = signal(
    typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches,
  );

  readonly provincias = signal<Provincia[]>([]);
  readonly localidades = signal<Localidad[]>([]);
  readonly cargandoLocalidades = signal(false);

  /** Query actual del filtro interno de cada select — para reordenar matches. */
  readonly provinciasQuery = signal('');
  readonly localidadesQuery = signal('');

  /** Lista re-ordenada con los que empiezan por la query antes que los que solo contienen. */
  readonly provinciasOrdenadas = computed(() =>
    ordenarPorPrefijo(this.provincias(), this.provinciasQuery(), (p) => p.nombre),
  );
  readonly localidadesOrdenadas = computed(() =>
    ordenarPorPrefijo(this.localidades(), this.localidadesQuery(), (l) => l.nombre),
  );

  /**
   * Escalones de descuento configurados (umbral subtotal s/IVA → % a aplicar).
   * Se cargan en el constructor desde el backend; mientras llegan se asume
   * lista vacía (sin descuento), lo cual es el default seguro.
   */
  readonly escalasDescuento = signal<EscalaDescuento[]>([]);

  /** Formas de pago activas (cargadas al iniciar). El operador elige una en
   *  el dropdown del carrito; el recargo % se aplica al total. */
  readonly formasPagoActivas = signal<FormaPago[]>([]);

  /** Forma de pago seleccionada por el operador. Null = sin financiación
   *  (precio base, equivalente a "Efectivo 1 cuota / 0%"). */
  readonly formaPagoSeleccionada = signal<FormaPago | null>(null);

  /** Escalones ordenados de mayor a menor umbral — útil para resolver el escalón vigente. */
  private readonly escalasDesc = computed(() =>
    [...this.escalasDescuento()].sort((a, b) => b.umbralMin - a.umbralMin),
  );

  /** Escalones ordenados de menor a mayor umbral — orden natural para mostrar
   *  los tiles "comprá más" (el más cercano primero, los mejores al final). */
  readonly escalasOrdenadas = computed(() =>
    [...this.escalasDescuento()].sort((a, b) => a.umbralMin - b.umbralMin),
  );

  /** Suma del PVP s/IVA por cantidad, sin aplicar descuento — base para decidir el escalón. */
  readonly subtotalPreDescuento = computed(() =>
    this.carrito().reduce(
      (acc, it) => acc + (it.pvpKtGastroSinIva ?? 0) * it.cantidad,
      0,
    ),
  );

  /** Descuento % vigente según el subtotal y los escalones configurados. */
  readonly descuentoAplicado = computed(() => {
    const sub = this.subtotalPreDescuento();
    const aplicable = this.escalasDesc().find((e) => sub >= e.umbralMin);
    return aplicable?.porcentaje ?? 0;
  });

  /** Monto del descuento (en pesos) sobre el subtotal pre-descuento. */
  readonly descuentoMonto = computed(
    () => (this.subtotalPreDescuento() * this.descuentoAplicado()) / 100,
  );

  readonly totalCarrito = computed(
    () => this.subtotalPreDescuento() - this.descuentoMonto(),
  );

  /** Recargo % vigente según la forma de pago elegida (0 si ninguna o si tiene 0%). */
  readonly recargoAplicado = computed(() => {
    const fp = this.formaPagoSeleccionada();
    return fp ? (fp.recargoPorcentaje ?? 0) : 0;
  });

  /** Si la forma de pago elegida agrega IVA al precio que ve el cliente.
   *  - Forma con {@code aplicaIva=true} (caso normal): cliente paga con IVA.
   *  - Forma con {@code aplicaIva=false} (ej: "transferencia sin IVA"):
   *    cliente paga sin IVA y el operador absorbe la diferencia.
   *  - Sin forma elegida (todavía no decidió): mostramos el "precio efectivo"
   *    sin IVA, igual al comportamiento histórico del carrito. */
  readonly aplicaIvaCliente = computed(() => {
    const fp = this.formaPagoSeleccionada();
    return fp ? (fp.aplicaIva ?? true) : false;
  });

  /** Recargo financiero puro (sin IVA): lo que el cliente paga de más sobre
   *  el subtotal sin IVA por elegir esta forma. Fórmula per-item:
   *  {@code base × (1/(1-recargo/100) - 1)}. */
  readonly recargoMontoSinIva = computed(() => {
    const recargo = this.recargoAplicado();
    if (recargo <= 0) return 0;
    const descuento = this.descuentoAplicado();
    const factorExtra = 1 / (1 - recargo / 100) - 1;
    return this.carrito().reduce((acc, it) => {
      const baseSinIva = (it.pvpKtGastroSinIva ?? 0) * (1 - descuento / 100);
      return acc + baseSinIva * factorExtra * it.cantidad;
    }, 0);
  });

  /** IVA que paga el cliente al final (sobre el subtotal con recargo aplicado).
   *  Cero si la forma de pago es "sin IVA" (operador absorbe). */
  readonly ivaMontoCarrito = computed(() => {
    if (!this.aplicaIvaCliente()) return 0;
    const recargo = this.recargoAplicado();
    const descuento = this.descuentoAplicado();
    const divisorRecargo = recargo > 0 ? 1 - recargo / 100 : 1;
    return this.carrito().reduce((acc, it) => {
      const porcIva = it.porcIva ?? 0;
      if (porcIva <= 0) return acc;
      const baseSinIva = (it.pvpKtGastroSinIva ?? 0) * (1 - descuento / 100);
      const conRecargoSinIva = baseSinIva / divisorRecargo;
      return acc + conRecargoSinIva * (porcIva / 100) * it.cantidad;
    }, 0);
  });

  /** Total final que el cliente paga: subtotal + recargo (sin IVA) + IVA (si la
   *  forma aplica). Equivale a {@code base × (aplicaIva ? (1+iva/100) : 1) / (1 - recargo/100)}
   *  per-item. */
  readonly totalConRecargo = computed(
    () => this.totalCarrito() + this.recargoMontoSinIva() + this.ivaMontoCarrito(),
  );

  /** Total final del carrito para una forma de pago dada — usado en el dialog
   *  "comparativa de formas de pago" que el operador le muestra al cliente. */
  totalParaForma(fp: FormaPago): number {
    const recargo = fp.recargoPorcentaje ?? 0;
    const aplicaIva = fp.aplicaIva ?? true;
    const descuento = this.descuentoAplicado();
    const divisorRecargo = recargo > 0 ? 1 - recargo / 100 : 1;
    return this.carrito().reduce((acc, it) => {
      const baseSinIva = (it.pvpKtGastroSinIva ?? 0) * (1 - descuento / 100);
      const conRecargoSinIva = baseSinIva / divisorRecargo;
      const porcIva = it.porcIva ?? 0;
      const unit = aplicaIva && porcIva > 0
        ? conRecargoSinIva * (1 + porcIva / 100)
        : conRecargoSinIva;
      return acc + unit * it.cantidad;
    }, 0);
  }

  /** Toggle del dialog que lista todas las formas con su total — para mostrar
   *  al cliente las opciones disponibles. */
  readonly mostrarDialogFormasPago = signal(false);

  abrirDialogFormasPago(): void {
    this.mostrarDialogFormasPago.set(true);
  }

  /** Selecciona la forma desde el dialog comparativo y lo cierra — el operador
   *  puede elegir directamente desde ahí sin volver al select. */
  elegirFormaDesdeDialog(fp: FormaPago): void {
    this.seleccionarFormaPago(fp);
    this.mostrarDialogFormasPago.set(false);
  }

  /** Forma de pago con el menor total — para el badge "MEJOR PRECIO". */
  readonly formaMasBarata = computed(() => {
    const formas = this.formasPagoActivas();
    if (formas.length === 0) return null;
    let min = formas[0];
    let minTotal = this.totalParaForma(min);
    for (const fp of formas.slice(1)) {
      const t = this.totalParaForma(fp);
      if (t < minTotal) {
        min = fp;
        minTotal = t;
      }
    }
    return min;
  });

  /** Ícono según cantidad de cuotas: pago contado vs financiado. */
  iconoForma(fp: FormaPago): string {
    return fp.cantidadCuotas && fp.cantidadCuotas > 1 ? 'pi pi-credit-card' : 'pi pi-money-bill';
  }

  readonly cantidadTotal = computed(() =>
    this.carrito().reduce((acc, it) => acc + it.cantidad, 0),
  );

  /** Precio unitario efectivo aplicando el descuento global vigente. */
  precioEfectivo(it: CarritoItem): number {
    const base = it.pvpKtGastroSinIva ?? 0;
    return base * (1 - this.descuentoAplicado() / 100);
  }

  /** Subtotal de la línea SIN descuento — el descuento se muestra solo a nivel total. */
  subtotal(it: CarritoItem): number {
    return (it.pvpKtGastroSinIva ?? 0) * it.cantidad;
  }

  /** Próximo escalón a alcanzar (umbralMin > subtotal actual), o null si ya está en el tope. */
  private readonly proximoEscalonObj = computed(() => {
    const sub = this.subtotalPreDescuento();
    return this.escalasDescuento().find((e) => sub < e.umbralMin) ?? null;
  });

  /** Pesos que faltan para llegar al próximo escalón — null si ya está en el tope. */
  readonly faltaParaProximo = computed(() => {
    const proximo = this.proximoEscalonObj();
    return proximo ? proximo.umbralMin - this.subtotalPreDescuento() : null;
  });

  /** % del próximo escalón al que se llegaría, null si ya está en el tope. */
  readonly proximoEscalon = computed(() => this.proximoEscalonObj()?.porcentaje ?? null);

  /** Datos para el {@code p-meterGroup} del carrito: visualiza qué tan cerca
   *  está el subtotal del próximo umbral de descuento. Null cuando ya estás
   *  en el tope (no hay próximo escalón). */
  readonly meterProximoEscalon = computed(() => {
    const proximo = this.proximoEscalonObj();
    if (!proximo) return null;
    const sub = this.subtotalPreDescuento();
    const acumulado = Math.min(sub, proximo.umbralMin);
    return {
      // Label vacío + ocultamos la label list via CSS (.meter-discount):
      // el texto "faltan $X para 10% off" arriba del bar ya dice todo.
      items: [{ label: '', value: acumulado, color: '#10b981' }],
      max: proximo.umbralMin,
    };
  });

  stockSeverity(stock: number | null): 'success' | 'danger' | 'secondary' {
    if (stock == null) return 'secondary';
    return stock > 0 ? 'success' : 'danger';
  }

  ahorro(base: number | null, descuento: number): number {
    if (base == null) return 0;
    return base * (descuento / 100);
  }

  /** Precio final aplicando el descuento. */
  precioConDescuento(base: number | null, descuento: number): number {
    if (base == null) return 0;
    return base - this.ahorro(base, descuento);
  }

  /** true si hay un escalón con umbral mayor (mejor descuento) que el precio
   *  ya alcanza. Usado para atenuar tiles "menores" cuando otro mejor aplica. */
  haySuperior(precio: number, escala: EscalaDescuento): boolean {
    return this.escalasOrdenadas().some(
      (e) => e.umbralMin > escala.umbralMin && precio >= e.umbralMin,
    );
  }

  /**
   * Esquema de colores para el tile N (0-indexado). 5 colores distintos
   * (ámbar → esmeralda → cielo → violeta → rosa), a partir del 6° cicla.
   */
  escalaColorScheme(i: number): {
    border: string;
    bg: string;
    pill: string;
    textTitle: string;
    textBig: string;
    textSmall: string;
    textItalic: string;
  } {
    return ESCALA_COLOR_SCHEMES[i % ESCALA_COLOR_SCHEMES.length];
  }

  /** Si la URL de la imagen falla al cargar, blanqueamos el campo para que aparezca el placeholder. */
  onImagenError(_e: Event): void {
    const r = this.ultimoScan();
    if (r?.imagenUrl) this.ultimoScan.set({ ...r, imagenUrl: null });
  }

  /** Mismo fallback pero para los thumbnails de los items del carrito. */
  onImagenErrorCarrito(sku: string): void {
    this.carrito.set(
      this.carrito().map((it) =>
        it.sku === sku && it.imagenUrl ? { ...it, imagenUrl: null } : it,
      ),
    );
  }

  /** Mismo fallback para los thumbnails de la lista de resultados de búsqueda. */
  onImagenResultadoError(sku: string): void {
    this.resultadosBusqueda.set(
      this.resultadosBusqueda().map((it) =>
        it.sku === sku && it.imagenUrl ? { ...it, imagenUrl: null } : it,
      ),
    );
  }

  /** Formato relativo "hace X min/hora/día" para fechas recientes. */
  tiempoRelativo(iso: string | null | undefined): string {
    if (!iso) return '—';
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 60_000) return 'hace unos segundos';
    const min = Math.floor(ms / 60_000);
    if (min < 60) return `hace ${min} min`;
    const hs = Math.floor(min / 60);
    if (hs < 24) return `hace ${hs} h`;
    const d = Math.floor(hs / 24);
    return `hace ${d} día${d === 1 ? '' : 's'}`;
  }

  /** Tope de cantidad para el InputNumber: stock conocido o 999 si DUX no informó. */
  maxCantidad(stock: number | null | undefined): number {
    return stock != null && stock > 0 ? stock : 999;
  }

  excedeStock(it: CarritoItem): boolean {
    // null = stock desconocido (no marcamos como excedido); cualquier número
    // (incluso negativo, que DUX a veces devuelve) cuenta — la cantidad pedida
    // tiene que entrar en el stock disponible.
    return it.stockTotal != null && it.cantidad > it.stockTotal;
  }

  readonly hayItemsExcedidos = computed(() => this.carrito().some((it) => this.excedeStock(it)));

  readonly puedeEnviar = computed(() => {
    const c = this.cliente();
    return (
      c.nroDoc != null &&
      this.cuitValido(c.nroDoc) &&
      this.emailValido(c.email) &&
      this.carrito().length > 0 &&
      !this.hayItemsExcedidos()
    );
  });

  /** Valor de `apellido_razon_social` que recibe DUX. Siempre es el placeholder
   *  fijo: la operadora lo asocia con el cliente real al editar el comprobante
   *  en DUX usando el CUIT. El nombre real del cliente va en el campo `nombre`
   *  del payload, no acá. */
  readonly apellidoRazonSocialFinal: string = APELLIDO_RAZON_SOCIAL;

  /** Hardcoded en el envío a DUX. Se expone al operador como input deshabilitado
   *  para que vea exactamente qué se carga, y se referencia desde el payload de
   *  `crearPedido` para no duplicar el literal. */
  readonly categoriaFiscalFinal: CategoriaFiscal = 'CONSUMIDOR_FINAL';

  /** Validación liviana de email — formato mínimo para que el backend lo acepte
   *  y se pueda mandar el follow-up con el PDF de historial. Coincide con el
   *  patrón del validador del email-picking en /configuracion. */
  emailValido(email: string | null | undefined): boolean {
    if (email == null) return false;
    const trimmed = email.trim();
    if (trimmed.length === 0) return false;
    return /^[^@\s,]+@[^@\s,]+\.[^@\s,]+$/.test(trimmed);
  }

  /** CUIT/CUIL = 11 dígitos. No validamos el dígito verificador para no rebotar
   * a la operadora si DUX lo acepta igual. */
  cuitValido(n: number | null | undefined): boolean {
    if (n == null) return false;
    const s = String(n);
    return s.length === 11;
  }

  /** Valor (string) que ve el inputMask: el nroDoc del cliente como dígitos puros
   *  para que la máscara `99-99999999-9` lo formatee con guiones automáticamente. */
  readonly cuitInputValue = computed(() => {
    const n = this.cliente().nroDoc;
    return n != null ? String(n) : '';
  });

  /** Recibe el valor del inputMask con [unmask]="true" — solo dígitos. Lo convertimos
   *  a number para que el resto del flujo (validación, payload a DUX) siga igual. */
  onCuitChange(value: string | null | undefined): void {
    const digits = (value ?? '').replace(/\D/g, '');
    this.actualizarCliente('nroDoc', digits ? Number(digits) : null);
  }

  constructor() {
    // Carga los escalones de descuento desde el backend al iniciar. Si la
    // request falla, la signal queda vacía → no se aplica ningún descuento
    // (default seguro: el operador siempre puede vender al precio de lista).
    this.api.obtenerEscalasDescuento().subscribe({
      next: (lista) => this.escalasDescuento.set(lista),
      error: (err) =>
        console.warn('[escalas-descuento] no se pudieron cargar:', err),
    });

    // Formas de pago activas — para el selector del carrito. La primera de la
    // lista (orden asc) queda seleccionada por default — el operador la
    // configuró como "default" desde /configuracion (p.ej. Efectivo).
    this.api.listarFormasPagoActivas().subscribe({
      next: (lista) => {
        this.formasPagoActivas.set(lista);
        if (lista.length > 0 && this.formaPagoSeleccionada() == null) {
          this.formaPagoSeleccionada.set(lista[0]);
        }
      },
      error: (err) =>
        console.warn('[formas-pago] no se pudieron cargar:', err),
    });

    // Hidratación inicial del carrito server-side. Si la pestaña recarga o se
    // abre una segunda PC, el estado se levanta del backend (sin localStorage).
    this.api.obtenerCarrito().subscribe({
      next: (state) => this.carrito.set(state.items),
      error: (err) => console.warn('[carrito] no se pudo hidratar:', err),
    });

    // Hidratación inicial de la sesión activa. Si había una en curso, la
    // levantamos para pre-llenar el form y mostrar el badge en el header.
    // Si no hay sesión activa (carga limpia / reinicio / cliente recién
    // terminado), abrimos el modal de "Nuevo cliente" automáticamente para
    // que el operador identifique al cliente antes de empezar a escanear.
    this.api.obtenerSesionActiva().subscribe({
      next: (s) => {
        this.aplicarSesion(s);
        if (s.id == null) {
          this.abrirDialogoNuevoCliente();
        }
      },
      error: (err) => console.warn('[sesion] no se pudo hidratar:', err),
    });

    // SSE en vivo: cualquier cambio en la sesión (iniciar/scan/finalizar)
    // que dispare cualquier PC llega acá y refresca el estado local.
    this.backendStatus.sesionEvents$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((s) => this.aplicarSesion(s));

    // Sincronización en vivo: cualquier mutación (esta PC, otra PC, visor,
    // sync de catálogo) llega como SSE y reemplaza el estado local. Según el
    // origen mostramos toasts diferenciados:
    //  - VISOR  → "cliente agregó al carrito X"
    //  - SISTEMA → tras un sync global de catálogo. Si el sync hizo que algún
    //              item quede con cantidad > stock disponible, alerta.
    this.backendStatus.carritoEvents$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((state) => {
        const previo = this.carrito();
        // VISOR y SISTEMA representan cambios externos que el operador DEBE
        // ver — el cliente agregó algo desde el celular, o el sync refrescó
        // stock/precio. Aplicar state.items directo.
        //
        // OPERADOR es nuestro propio PATCH echando vía SSE — puede llegar con
        // una cantidad stale si el user clickeó de nuevo entre el PATCH y la
        // respuesta. Aplicar via merge para preservar cantidad local y evitar
        // el rebote visible del input.
        if (state.origen === 'OPERADOR') {
          this.carrito.set(this.mergeRemotoRespetandoLocal(state.items));
        } else {
          this.carrito.set(state.items);
          if (state.origen === 'VISOR') {
            this.mostrarToastCambioDesdeVisor(previo, state.items);
          } else if (state.origen === 'SISTEMA') {
            this.mostrarToastStockTrasSync(previo, state.items);
          }
        }
      });

    // Updates de cantidad del carrito — agrupadas por SKU, con debounce.
    // Clickear +/- rápido sobre el mismo item colapsa en UN solo PATCH con
    // el valor final. switchMap descarta in-flights stale si llega un valor
    // nuevo después del debounce. Si el backend recortó al stock, el toast
    // avisa y el carrito se reconcilia con el state real.
    this.cantidadUpdates$
      .pipe(
        groupBy((u) => u.sku),
        mergeMap((porSku) =>
          porSku.pipe(
            debounceTime(250),
            switchMap((u) =>
              this.api.actualizarCantidadItemCarrito(u.sku, u.cantidad).pipe(
                tap((state) => {
                  const item = state.items.find((it) => it.sku === u.sku);
                  if (item && item.cantidad < u.cantidad) {
                    // Recortado por stock — el server tiene menos disponible
                    // que lo que pidió el user. Aceptamos siempre (el max del
                    // stepper se va a actualizar al nuevo stock) y avisamos.
                    this.toast.add({
                      severity: 'warn',
                      summary: 'Cantidad ajustada al stock',
                      detail: `${u.sku}: tope ${item.cantidad} unidades.`,
                      life: 3500,
                    });
                    this.carrito.set(state.items);
                  } else {
                    // No hubo recortado. Aplicar state preservando cantidad
                    // local para items que el user puede haber tocado entre
                    // que mandamos este PATCH y volvió la respuesta — evita
                    // el rebote visual del input.
                    this.carrito.set(this.mergeRemotoRespetandoLocal(state.items));
                  }
                }),
                catchError((err) => {
                  toastError(this.toast, 'Carrito', err, 'No se pudo actualizar la cantidad.');
                  return EMPTY;
                }),
              ),
            ),
          ),
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe();

    if (typeof window === 'undefined') return;

    const mq = window.matchMedia('(min-width: 1024px)');
    const sync = (e: MediaQueryListEvent | MediaQueryList) => this.screenLg.set(e.matches);
    mq.addEventListener('change', sync as (e: MediaQueryListEvent) => void);
    this.destroyRef.onDestroy(() =>
      mq.removeEventListener('change', sync as (e: MediaQueryListEvent) => void),
    );

    // En dispositivos táctiles (tablets/phones) reenfocar al click abre el
    // teclado virtual cada vez que tocan algo. Solo activamos el auto-refocus
    // si hay puntero fino (mouse + pistola HID conectada por USB).
    const isCoarse = window.matchMedia('(pointer: coarse)').matches;
    if (isCoarse) return;

    // Refocus al scan input cuando se CIERRA cualquier dialog (transición
    // open → closed). Sin esto, el operador queda con el focus en el botón
    // que cerró el dialog y la pistola QR no escanea hasta clickear el input.
    // El handler global de click NO cubre este caso porque excluye botones.
    let dialogAbiertoPrevio = false;
    effect(() => {
      const algunoAbierto =
        this.mostrarDialogoNuevoCliente() ||
        this.mostrarConfirmacion() ||
        this.mostrarDialogVisor() ||
        this.mostrarDialogReview() ||
        this.mostrarSyncDialog();
      if (dialogAbiertoPrevio && !algunoAbierto) {
        this.focusInput();
      }
      dialogAbiertoPrevio = algunoAbierto;
    });

    const refocus = (e: MouseEvent) => {
      if (this.mostrarConfirmacion()) return;
      const target = e.target as HTMLElement | null;
      if (
        target?.closest(
          'input, textarea, select, button, [role="button"], a, label, ' +
            '.p-inputnumber, .p-select, .p-selectbutton, .p-toggleswitch, ' +
            '.p-dialog, .p-tooltip',
        )
      ) {
        return;
      }
      this.focusInput();
    };
    document.addEventListener('click', refocus);
    this.destroyRef.onDestroy(() => document.removeEventListener('click', refocus));
  }

  ngAfterViewInit(): void {
    // En desktop enfocamos automáticamente para que la pistola QR funcione sin click.
    // En táctil, NO — el teclado virtual saltaría al cargar la página.
    if (typeof window === 'undefined' || !window.matchMedia('(pointer: coarse)').matches) {
      this.focusInput();
    }
  }

  @HostListener('document:keydown', ['$event'])
  onKeyDown(e: KeyboardEvent): void {
    if (e.key === '/' && !this.mostrarConfirmacion()) {
      const target = e.target as HTMLElement;
      if (target?.tagName !== 'INPUT' && target?.tagName !== 'TEXTAREA') {
        e.preventDefault();
        this.focusInput();
      }
    }
  }

  /** Devuelve el foco al input del scan. Público para poder llamarlo desde
   *  los {@code (onHide)} de los p-dialog del template — así cualquier dialog
   *  que se cierre deja al operador listo para seguir escaneando. Usamos
   *  {@code setTimeout(0)} en vez de {@code queueMicrotask} porque PrimeNG
   *  retoma el focus en su propio trigger durante el cleanup del dialog/select,
   *  y el microtask no alcanza para correr después de eso. */
  focusInput(): void {
    setTimeout(() => this.scanInput()?.nativeElement.focus(), 0);
  }

  /** Setea la forma de pago y devuelve el foco al input del scan — así el
   *  operador sigue escaneando sin tener que clickear de nuevo. */
  seleccionarFormaPago(fp: FormaPago | null): void {
    this.formaPagoSeleccionada.set(fp);
    this.focusInput();
  }

  confirmarSincronizar(): void {
    if (this.health()?.syncEnCurso) {
      this.toast.add({
        severity: 'info',
        summary: 'Sincronización en curso',
        detail: 'Ya hay un sync corriendo en background.',
      });
      return;
    }
    this.forzarSyncCompleto.set(false);
    this.mostrarSyncDialog.set(true);
  }

  ejecutarSync(): void {
    const force = this.forzarSyncCompleto();
    this.mostrarSyncDialog.set(false);
    this.api.syncCatalogo(force).subscribe({
      next: () => {
        this.toast.add({
          severity: 'info',
          summary: force ? 'Sync completo iniciado' : 'Sincronización iniciada',
          detail: force
            ? 'Descarga todo el catálogo (~15 min). El banner global muestra el progreso.'
            : 'Va a correr en background. El banner global muestra el progreso.',
          life: 5000,
        });
        this.syncState.refrescarHealth();
      },
      error: (err) => toastError(this.toast, 'Sync', err, 'No se pudo iniciar el sync'),
    });
  }

  /**
   * Abre el dialog "QR para celular" que muestra dos imágenes pre-generadas
   * desde {@code public/}: {@code conexion-wifi.png} (auto-conexión a la red del
   * showroom) y {@code qr-precios.png} (link al visor de precios).
   */
  abrirDialogVisor(): void {
    this.mostrarDialogVisor.set(true);
  }

  /** Cierra la sesión y redirige al login. */
  cerrarSesion(): void {
    this.auth.logout().subscribe({
      next: () => this.router.navigate(['/login']),
      error: () => {
        // Igual mandamos al login — el logout también limpió el signal local.
        this.router.navigate(['/login']);
      },
    });
  }

  /**
   * Submit del input principal. Si la entrada parece un código (solo dígitos),
   * intenta match exacto por SKU/EAN — `/scan` también hace fallback a DUX
   * on-demand (~7s) si el código no está en cache, lo que es deseable para
   * un SKU recién creado en DUX. Si no encuentra exacto, fallback a búsqueda
   * por descripción.
   *
   * Si la entrada es texto descriptivo ("olive", "sarten", "20 cm"), va
   * directo a búsqueda por descripción contra `/catalogo` — evita la espera
   * de 7s del rate limit DUX para consultas que sabemos que no son códigos.
   */
  onSubmitScan(): void {
    const query = this.skuInput().trim();
    if (!query) return;
    this.skuInput.set('');
    this.resultadosBusqueda.set([]);

    // Cada nuevo scan/búsqueda recibe un número de secuencia. Si llega la
    // respuesta de uno anterior (más lento), la descartamos.
    const seq = ++this.scanSeq;

    // Heurística: solo dígitos → es un SKU/EAN, vale la pena probar exact match.
    // Cualquier otra cosa (letras, espacios, símbolos) → es texto descriptivo,
    // saltamos a la búsqueda directamente.
    const esCodigo = /^\d+$/.test(query);

    if (esCodigo) {
      this.cargandoScan.set(true);
      this.api.scan(query).subscribe({
        next: (r) => {
          if (seq !== this.scanSeq) return;
          this.cargandoScan.set(false);
          this.ultimoScan.set(r);
          this.cantidadInput.set(1);
          this.focusInput();
          if (r.habilitado === false) {
            this.toast.add({
              severity: 'warn',
              summary: 'Producto deshabilitado',
              detail: r.sku,
            });
          }
        },
        error: (err) => {
          if (seq !== this.scanSeq) return;
          // 404 = código no encontrado en cache ni en DUX → fallback a búsqueda
          // (por si era un SKU parcial o si está indexado por barcode contains).
          if (err?.status === 404) {
            this.cargandoScan.set(true);
            this.buscarPorDescripcion(query);
          } else {
            this.cargandoScan.set(false);
            this.ultimoScan.set(null);
            this.focusInput();
            toastError(this.toast, 'Scan', err, 'Error al consultar SKU');
          }
        },
      });
    } else {
      this.cargandoScan.set(true);
      this.buscarPorDescripcion(query);
    }
  }

  /** Búsqueda por descripción/SKU/EAN contra el catálogo cacheado. Se dispara
   *  como fallback cuando el scan exacto no encuentra el código, o directamente
   *  cuando la query es texto descriptivo. Carga la primera página; el operador
   *  puede traer más con `cargarMasResultados()`. */
  private buscarPorDescripcion(query: string): void {
    const seq = ++this.scanSeq;
    this.busquedaQuery.set(query);
    this.paginaResultados.set(0);
    this.api.buscarCatalogo(query, 0, this.BUSQUEDA_PAGE_SIZE).subscribe({
      next: (page) => {
        if (seq !== this.scanSeq) return;
        this.cargandoScan.set(false);
        if (page.items.length === 0) {
          this.toast.add({
            severity: 'warn',
            summary: 'Sin resultados',
            detail: `No encontré nada que coincida con "${query}".`,
          });
          this.ultimoScan.set(null);
          this.resultadosBusqueda.set([]);
          this.totalResultadosBusqueda.set(0);
        } else if (page.items.length === 1 && page.total === 1) {
          // Único resultado en TODO el catálogo (no solo en la primera página)
          // — lo cargamos directo, ahorrando un click.
          this.totalResultadosBusqueda.set(1);
          this.seleccionarResultado(page.items[0].sku);
          return;
        } else {
          this.resultadosBusqueda.set(page.items);
          this.totalResultadosBusqueda.set(page.total);
          this.ultimoScan.set(null);
        }
        this.focusInput();
      },
      error: (err) => {
        if (seq !== this.scanSeq) return;
        this.cargandoScan.set(false);
        this.focusInput();
        toastError(this.toast, 'Búsqueda', err, 'No se pudo buscar');
      },
    });
  }

  /** Carga la siguiente página de resultados de búsqueda y la appendea a la
   *  lista visible. No-op si ya están todos cargados o si hay otra carga en
   *  curso (evita doble click). */
  cargarMasResultados(): void {
    if (this.cargandoMasResultados()) return;
    if (this.resultadosBusqueda().length >= this.totalResultadosBusqueda()) return;
    this.cargandoMasResultados.set(true);
    // No incrementamos scanSeq — solo capturamos. Si entre que pedimos la
    // página y vuelve, el operador hizo una búsqueda nueva, descartamos.
    const seq = this.scanSeq;
    const nextPage = this.paginaResultados() + 1;
    this.api.buscarCatalogo(this.busquedaQuery(), nextPage, this.BUSQUEDA_PAGE_SIZE).subscribe({
      next: (page) => {
        if (seq !== this.scanSeq) return;
        this.cargandoMasResultados.set(false);
        this.paginaResultados.set(nextPage);
        this.resultadosBusqueda.set([...this.resultadosBusqueda(), ...page.items]);
        // Devolvemos foco al input para que la pistola/teclado siga "tipeando"
        // ahí sin que el operador tenga que clickear.
        this.focusInput();
      },
      error: (err) => {
        if (seq !== this.scanSeq) return;
        this.cargandoMasResultados.set(false);
        this.focusInput();
        toastError(this.toast, 'Búsqueda', err, 'No se pudieron cargar más resultados');
      },
    });
  }

  /** Cierra la lista de resultados de búsqueda y vuelve a enfocar el input.
   *  Lo usa el botón "✕" del header de resultados. */
  cerrarResultadosBusqueda(): void {
    this.resultadosBusqueda.set([]);
    this.focusInput();
  }

  /** Cuando el operador click un item de la lista de resultados, lo cargamos
   *  como si lo hubiera scaneado — pasa por `/scan/{sku}` para obtener todos
   *  los datos completos (precios escalonados, imagen, etc.). */
  seleccionarResultado(sku: string): void {
    this.resultadosBusqueda.set([]);
    this.cargandoScan.set(true);
    const seq = ++this.scanSeq;
    this.api.scan(sku).subscribe({
      next: (r) => {
        if (seq !== this.scanSeq) return;
        this.cargandoScan.set(false);
        this.ultimoScan.set(r);
        this.cantidadInput.set(1);
        this.focusInput();
      },
      error: (err) => {
        if (seq !== this.scanSeq) return;
        this.cargandoScan.set(false);
        this.focusInput();
        toastError(this.toast, 'Cargar producto', err, 'No se pudo cargar el producto');
      },
    });
  }

  /** Un producto es vendible cuando está habilitado, tiene stock disponible y
   *  además tiene un precio cargado en la lista KT GASTRO. Si el precio es 0
   *  o null, lo más probable es que DUX no tenga ese item en la lista — agregarlo
   *  generaría un pedido fantasma sin total. */
  productoVendible(r: ScanResult): boolean {
    if (r.habilitado === false) return false;
    if (r.stockTotal != null && r.stockTotal <= 0) return false;
    if (r.pvpKtGastroConIva == null || r.pvpKtGastroConIva <= 0) return false;
    return true;
  }

  agregarAlCarrito(cantidad: number = 1): void {
    const r = this.ultimoScan();
    if (!r) return;
    if (!this.productoVendible(r)) {
      const motivo = r.habilitado === false
        ? 'el producto está deshabilitado'
        : (r.stockTotal != null && r.stockTotal <= 0)
          ? 'no tiene stock disponible'
          : 'no tiene precio cargado en la lista KT GASTRO';
      this.toast.add({
        severity: 'warn',
        summary: 'No se puede agregar',
        detail: `${r.sku}: ${motivo}.`,
      });
      return;
    }
    const cant = cantidad <= 0 ? 1 : cantidad;
    this.api.agregarItemCarrito(r.sku, cant).subscribe({
      next: (res) => {
        // El SSE carrito-updated ya va a llegar (con el state nuevo); igual
        // tocamos `this.carrito` con el state del response para no esperar
        // al round-trip del SSE en la misma pantalla.
        this.carrito.set(res.carrito.items);
        if (res.cantidadAgregada === 0) {
          this.toast.add({
            severity: 'warn',
            summary: 'Sin stock',
            detail: `${r.sku}: ${res.motivo ?? 'no se pudieron sumar unidades.'}`,
          });
        } else {
          this.toast.add({
            severity: res.recortado ? 'warn' : 'success',
            summary: res.recortado ? 'Cantidad ajustada al stock' : 'Agregado',
            detail: res.recortado
              ? `${r.sku} x${res.cantidadAgregada} (tope ${r.stockTotal}).`
              : `${r.sku} x${res.cantidadAgregada}`,
            life: res.recortado ? 3500 : 1500,
          });
        }
        this.focusInput();
      },
      error: (err) => toastError(this.toast, 'Carrito', err, 'No se pudo agregar al carrito.'),
    });
  }

  /** Toast warn cuando un sync global del catálogo dejó items del carrito con
   *  cantidad > stock disponible. Solo notifica los items que ANTES estaban
   *  OK y AHORA quedaron excedidos (los que ya estaban excedidos no tiene
   *  sentido re-alertar, el operador ya los está viendo en rojo). */
  private mostrarToastStockTrasSync(previo: CarritoItem[], nuevo: CarritoItem[]): void {
    const prevMap = new Map(previo.map((it) => [it.sku, it]));
    const ahoraExcedidos: string[] = [];
    for (const it of nuevo) {
      const stock = it.stockTotal;
      if (stock == null || it.cantidad <= stock) continue;
      const antes = prevMap.get(it.sku);
      const estabaExcedido = antes != null && antes.stockTotal != null && antes.cantidad > antes.stockTotal;
      if (!estabaExcedido) {
        ahoraExcedidos.push(`${it.sku} (${it.cantidad}→${stock})`);
      }
    }
    if (ahoraExcedidos.length === 0) return;
    this.toast.add({
      severity: 'warn',
      summary: 'Stock actualizado tras sincronización',
      detail: `Items que ya no tienen stock suficiente: ${ahoraExcedidos.join(', ')}`,
      life: 10000,
    });
  }

  /** Toast informativo cuando un add proviene del visor (cliente en su celular).
   *  Compara estado previo vs nuevo para decidir qué SKUs cambiaron y cuánto. */
  private mostrarToastCambioDesdeVisor(previo: CarritoItem[], nuevo: CarritoItem[]): void {
    const prevMap = new Map(previo.map((it) => [it.sku, it.cantidad]));
    const cambios: string[] = [];
    for (const it of nuevo) {
      const antes = prevMap.get(it.sku) ?? 0;
      const diff = it.cantidad - antes;
      if (diff > 0) cambios.push(`${it.sku} x${diff}`);
    }
    if (cambios.length === 0) return;
    this.toast.add({
      severity: 'info',
      summary: 'Cliente agregó al carrito',
      detail: cambios.join(', '),
      life: 4000,
    });
  }

  actualizarCantidad(sku: string, cantidad: number): void {
    // Mínimo 1 — para eliminar el item está la X dedicada al lado.
    const c = Math.max(1, cantidad ?? 1);
    // Update local optimista: la UI (cant. total, subtotal, etc.) responde
    // instantáneo aunque el PATCH al backend se debouncee 250ms.
    this.carrito.set(
      this.carrito().map((it) => (it.sku === sku ? { ...it, cantidad: c } : it)),
    );
    this.cantidadUpdates$.next({ sku, cantidad: c });
  }

  /**
   * Merge un state remoto del carrito (de la API o del SSE) con el local,
   * preservando la cantidad LOCAL para items donde difiere de la remota.
   *
   * <p>Por qué: cuando el user clickea +/- rápido, hay una ventana entre que
   * mandamos un PATCH y vuelve la respuesta donde el user puede haber clickeado
   * de nuevo. Si pisamos la cantidad local con la del response (que es la del
   * PATCH anterior, ya stale), la UI rebota: el input vuelve al valor viejo y
   * después salta al nuevo cuando el siguiente PATCH responde. Lo mismo con
   * SSE de updates concurrentes.
   *
   * <p>Para items con misma cantidad: traemos todos los fields del remoto
   * (stock fresco, precio, descripción, imagen) — ese es el caso normal y la
   * razón por la que aplicamos el state remoto.
   *
   * <p>Para items donde la cantidad local difiere: traemos los fields no-cantidad
   * del remoto pero preservamos la cantidad local. El próximo PATCH va a
   * sincronizar la cantidad correctamente con backend.
   *
   * <p>Items que están en remoto pero no en local: se agregan tal cual (típico:
   * el visor o otro operador agregó un item nuevo).
   *
   * <p>Items en local pero no en remoto: se descartan (item eliminado en otro lado).
   */
  private mergeRemotoRespetandoLocal(remoteItems: CarritoItem[]): CarritoItem[] {
    const localBySku = new Map(this.carrito().map((it) => [it.sku, it]));
    return remoteItems.map((remote) => {
      const local = localBySku.get(remote.sku);
      if (local && local.cantidad !== remote.cantidad) {
        return { ...remote, cantidad: local.cantidad };
      }
      return remote;
    });
  }

  eliminarDelCarrito(sku: string): void {
    this.api.eliminarItemCarrito(sku).subscribe({
      next: (state) => {
        this.carrito.set(state.items);
        this.focusInput();
      },
      error: (err) => {
        toastError(this.toast, 'Carrito', err, 'No se pudo eliminar el item.');
        this.focusInput();
      },
    });
  }

  vaciarCarrito(): void {
    // Vaciamos optimisticamente en pantalla; si el backend rechaza, el SSE
    // siguiente lo va a corregir. Esto evita que el operador vea el carrito
    // viejo unos ms tras enviar el pedido.
    this.carrito.set([]);
    this.ultimoScan.set(null);
    this.focusInput();
    this.api.vaciarCarritoServer().subscribe({
      next: (state) => this.carrito.set(state.items),
      error: (err) => toastError(this.toast, 'Carrito', err, 'No se pudo vaciar el carrito.'),
    });
  }

  /** Refresh on-demand del producto que el operador acaba de scanear.
   *  Útil cuando el cliente pide un producto cuya última sincronización es vieja
   *  y queremos confirmar stock/precio actuales sin tener que re-scanear. */
  refrescarScan(): void {
    const r = this.ultimoScan();
    if (!r) return;
    this.refrescandoScan.set(true);
    const seq = ++this.scanSeq;
    this.api.refreshStock([r.sku]).subscribe({
      next: (resultados) => {
        if (seq !== this.scanSeq) return;
        this.refrescandoScan.set(false);
        const fresh = resultados[0];
        if (fresh) {
          this.ultimoScan.set(fresh);
          this.toast.add({
            severity: 'success',
            summary: 'Producto actualizado',
            detail: `${fresh.sku} — stock: ${fresh.stockTotal ?? 0}`,
            life: 2500,
          });
        }
        this.focusInput();
      },
      error: (err) => {
        if (seq !== this.scanSeq) return;
        this.refrescandoScan.set(false);
        this.focusInput();
        toastError(this.toast, 'Refrescar', err, 'No se pudo refrescar');
      },
    });
  }

  refrescarStockCarrito(): void {
    if (this.carrito().length === 0) return;
    this.refrescando.set(true);
    this.api.refrescarStockCarritoServer().subscribe({
      next: (state) => {
        this.refrescando.set(false);
        const excedidos: string[] = [];
        for (const it of state.items) {
          if (it.stockTotal != null && it.stockTotal >= 0 && it.cantidad > it.stockTotal) {
            excedidos.push(`${it.sku} (${it.cantidad}→${it.stockTotal})`);
          }
        }
        this.carrito.set(state.items);
        if (excedidos.length > 0) {
          this.toast.add({
            severity: 'warn',
            summary: 'Items con stock insuficiente',
            detail: `Ajustar: ${excedidos.join(', ')}`,
            life: 8000,
          });
        } else {
          this.toast.add({
            severity: 'success',
            summary: 'Stock actualizado',
            detail: `${state.items.length} items refrescados desde DUX`,
          });
        }
        this.focusInput();
      },
      error: (err) => {
        this.refrescando.set(false);
        toastError(this.toast, 'Refrescar', err, 'No se pudo refrescar stock');
        this.focusInput();
      },
    });
  }

  abrirConfirmacion(): void {
    if (this.carrito().length === 0) return;
    this.mostrarConfirmacion.set(true);
    this.cargarProvinciasSiHaceFalta();
  }

  actualizarCliente<K extends keyof DatosCliente>(campo: K, valor: DatosCliente[K]): void {
    this.cliente.set({ ...this.cliente(), [campo]: valor });
  }

  // =====================================================
  // Sesión de atención al cliente
  // =====================================================

  /** Aplica el estado de sesión recibido del backend (hidratación inicial
   *  y SSE). Si la sesión está activa y el form todavía tiene el campo
   *  "Nombre y apellido" vacío, lo pre-rellena con el nombre cargado. */
  private aplicarSesion(s: SesionShowroom): void {
    this.sesionActiva.set(s);
    if (s.id != null && s.nombre && !this.cliente().nombre.trim()) {
      this.actualizarCliente('nombre', s.nombre);
    }
  }

  abrirDialogoNuevoCliente(): void {
    this.nombreNuevoCliente.set('');
    this.mostrarDialogoNuevoCliente.set(true);
  }

  /** Cierre del dialog post-pedido ("Gracias por tu compra"). Si después de
   *  cerrarlo el operador no tiene sesión activa (el caso natural — el
   *  pedido recién creado la cerró), arranca el flujo del próximo cliente
   *  abriendo el modal de "Nuevo cliente" — mismo patrón que la carga inicial
   *  de la página, para consistencia. */
  cerrarReviewYContinuar(): void {
    this.mostrarDialogReview.set(false);
    if (!this.haySesionActiva()) {
      this.abrirDialogoNuevoCliente();
    }
  }

  confirmarNuevoCliente(): void {
    const nombre = this.nombreNuevoCliente().trim();
    if (!nombre) {
      this.toast.add({
        severity: 'warn',
        summary: 'Nombre requerido',
        detail: 'Cargá el nombre del cliente para iniciar la sesión.',
        life: 3500,
      });
      return;
    }
    this.iniciandoSesion.set(true);
    this.api.iniciarSesion(nombre).subscribe({
      next: (s) => {
        this.iniciandoSesion.set(false);
        this.mostrarDialogoNuevoCliente.set(false);
        // Aplicamos manualmente para que el pre-fill del nombre arranque ya
        // (sin esperar el SSE). El SSE igual va a llegar y será idempotente.
        this.aplicarSesion(s);
        // Pre-fill explícito del nombre del cliente en el form de pedido —
        // pisa cualquier valor previo porque arranca cliente nuevo.
        this.actualizarCliente('nombre', nombre);
        this.toast.add({
          severity: 'success',
          summary: 'Sesión iniciada',
          detail: `Atendiendo a ${nombre}. Los scans quedan registrados para el follow-up.`,
          life: 3500,
        });
      },
      error: (err) => {
        this.iniciandoSesion.set(false);
        toastError(this.toast, 'Sesión', err, 'No se pudo iniciar la sesión.');
      },
    });
  }

  /** Abre el dialog de confirmación antes de cancelar — evita pérdidas
   *  accidentales de la sesión (perdés el conteo de scans + el cliente
   *  queda sin PDF de follow-up al cerrar el pedido). Usa el ConfirmDialog
   *  global declarado en app.html. */
  confirmarCancelarSesion(): void {
    if (!this.haySesionActiva()) return;
    const nombre = this.sesionActiva().nombre ?? '';
    this.confirmationService.confirm({
      header: 'Finalizar sesión',
      message:
        `¿Finalizar la sesión de "${nombre}"?\n\n` +
        `Los scans registrados se conservan en el historial, pero a partir de ` +
        `ahora los nuevos escaneos no se van a registrar hasta que inicies otra sesión.`,
      icon: 'pi pi-exclamation-triangle',
      acceptButtonProps: {
        label: 'Finalizar sesión',
        icon: 'pi pi-times-circle',
        severity: 'danger',
      },
      rejectButtonProps: {
        label: 'Cancelar',
        severity: 'secondary',
        outlined: true,
      },
      accept: () => this.cancelarSesionActiva(),
      // Refocus al input también si el operador cancela el dialog — el ConfirmDialog
      // de PrimeNG no emite (onHide), hay que cubrir ambos branches a mano.
      reject: () => this.focusInput(),
    });
  }

  cancelarSesionActiva(): void {
    if (!this.haySesionActiva()) return;
    // El ConfirmDialog de PrimeNG (que viene de confirmarCancelarSesion) NO
    // tiene un signal que el effect de refocus pueda observar, así que
    // refocusemos manualmente acá.
    this.api.cancelarSesion().subscribe({
      next: (s) => {
        this.aplicarSesion(s);
        this.toast.add({
          severity: 'info',
          summary: 'Sesión cancelada',
          detail: 'Los próximos scans no se van a registrar hasta iniciar una nueva sesión.',
          life: 3500,
        });
        this.focusInput();
      },
      error: (err) => {
        toastError(this.toast, 'Sesión', err, 'No se pudo cancelar la sesión.');
        this.focusInput();
      },
    });
  }

  /**
   * Genera sugerencias para el autocomplete del email basadas en lo que tipeó el operador:
   *  - Sin `@` todavía: sugerir `<lo-que-escribió>@<dominio>` para los dominios populares.
   *  - Con `@` ya escrito: filtrar la lista de dominios por los que matchean lo que sigue.
   *  - Si ya hay un dominio completo válido (otro `.` después del `@`), no sugerir nada
   *    (no pisar la elección manual del operador).
   */
  onCompletarEmail(event: AutoCompleteCompleteEvent): void {
    const query = (event.query ?? '').trim();
    if (!query) {
      this.sugerenciasEmail.set([]);
      return;
    }
    const at = query.indexOf('@');
    if (at < 0) {
      // No tiene @ — sugerir todos los dominios.
      this.sugerenciasEmail.set(DOMINIOS_EMAIL_SUGERIDOS.map((d) => `${query}@${d}`));
      return;
    }
    const localPart = query.substring(0, at);
    const dominioPart = query.substring(at + 1).toLowerCase();
    if (!localPart) {
      this.sugerenciasEmail.set([]);
      return;
    }
    // Si ya hay un dominio "completo" (algo.algo), no sugerimos.
    if (dominioPart.includes('.') && !DOMINIOS_EMAIL_SUGERIDOS.some((d) => d.startsWith(dominioPart))) {
      this.sugerenciasEmail.set([]);
      return;
    }
    this.sugerenciasEmail.set(
      DOMINIOS_EMAIL_SUGERIDOS
        .filter((d) => d.startsWith(dominioPart))
        .map((d) => `${localPart}@${d}`),
    );
  }

  /**
   * Carga la lista de provincias la primera vez que se abre el dialog.
   * El backend ya cachea, así que llamadas subsiguientes son baratas — pero
   * igual evitamos una HTTP innecesaria cuando ya está en memoria del frontend.
   */
  private cargarProvinciasSiHaceFalta(): void {
    if (this.provincias().length > 0) return;
    this.api.obtenerProvincias().subscribe({
      next: (lista) => this.provincias.set(lista),
      error: (err) =>
        toastError(this.toast, 'Provincias', err, 'No se pudieron cargar las provincias'),
    });
  }

  /** Subscription a la request en curso de localidades — para poder cancelarla. */
  private localidadesSub: Subscription | null = null;

  cambiarProvincia(codigo: string | null): void {
    // Si ya había una request en curso (otra provincia), abortarla.
    this.localidadesSub?.unsubscribe();
    this.localidadesSub = null;

    this.cliente.set({
      ...this.cliente(),
      codigoProvincia: codigo,
      idLocalidad: null,
    });
    this.localidades.set([]);
    if (!codigo) {
      this.cargandoLocalidades.set(false);
      return;
    }
    this.cargandoLocalidades.set(true);
    this.localidadesSub = this.api.obtenerLocalidades(codigo).subscribe({
      next: (lista) => {
        this.cargandoLocalidades.set(false);
        this.localidades.set(lista);
        this.localidadesSub = null;
      },
      error: (err) => {
        this.cargandoLocalidades.set(false);
        this.localidadesSub = null;
        toastError(this.toast, 'Localidades', err, 'No se pudieron cargar las localidades');
      },
    });
  }

  onFilterProvincias(event: { filter: string }): void {
    this.provinciasQuery.set(event.filter || '');
  }

  onFilterLocalidades(event: { filter: string }): void {
    this.localidadesQuery.set(event.filter || '');
  }

  scrollAlInicio(): void {
    if (typeof window !== 'undefined') {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    this.focusInput();
  }

  /**
   * Cancela la búsqueda de localidades en curso y limpia la provincia para que
   * el operador pueda elegir otra. La descarga sigue en el backend (donde se
   * guarda en BD, así que no es trabajo perdido), pero la UI ya no espera.
   */
  cancelarBusquedaLocalidades(): void {
    this.localidadesSub?.unsubscribe();
    this.localidadesSub = null;
    this.cargandoLocalidades.set(false);
    this.localidades.set([]);
    this.cliente.set({
      ...this.cliente(),
      codigoProvincia: null,
      idLocalidad: null,
    });
  }

  /**
   * Click en "Enviar a DUX" del diálogo de confirmación.
   *
   * Flujo:
   *  1. Validaciones básicas (stock, datos del cliente).
   *  2. Si `verificarStockAlEnviar()` está activo, refresca stock+precio
   *     contra DUX. Si encuentra excedidos cierra el diálogo y avisa al
   *     operador (los datos del cliente se preservan en el signal).
   *     Si solo cambió el precio, avisa y sigue con los nuevos valores.
   *  3. Manda el pedido a DUX.
   */
  confirmarEnvio(): void {
    if (this.hayItemsExcedidos()) {
      this.toast.add({
        severity: 'warn',
        summary: 'Hay items que superan el stock',
        detail: 'Ajustá las cantidades antes de enviar a DUX.',
      });
      return;
    }
    if (!this.puedeEnviar()) {
      this.toast.add({
        severity: 'warn',
        summary: 'Faltan datos',
        detail: 'CUIT (11 dígitos) requerido.',
      });
      return;
    }

    if (!this.verificarStockAlEnviar()) {
      this.enviarPedido();
      return;
    }

    // Refresh contra DUX antes de enviar — última validación. El backend
    // sincroniza el cache + actualiza el carrito server-side (todas las PCs
    // ven el nuevo stock vía SSE). Acá solo leemos el state resultante para
    // detectar excedidos y mantenemos las cantidades pedidas (el operador
    // decide si recortarlas en el diálogo).
    const cantidadesPedidas = new Map(this.carrito().map((it) => [it.sku, it.cantidad]));
    this.refrescando.set(true);
    this.api.refrescarStockCarritoServer().subscribe({
      next: (state) => {
        this.refrescando.set(false);
        this.carrito.set(state.items);
        const excedidos: {
          sku: string;
          descripcion: string | null;
          cantidadPedida: number;
          stockDisponible: number;
        }[] = [];
        for (const it of state.items) {
          const pedida = cantidadesPedidas.get(it.sku) ?? it.cantidad;
          const stock = it.stockTotal;
          if (stock != null && pedida > stock) {
            excedidos.push({
              sku: it.sku,
              descripcion: it.descripcion,
              cantidadPedida: pedida,
              stockDisponible: stock,
            });
          }
        }

        if (excedidos.length > 0) {
          // Stock cambió y ya no alcanza — cerramos el diálogo de confirmación
          // y abrimos uno dedicado con la lista detallada (SKU, descripción,
          // cantidad pedida vs stock disponible). El diálogo se cierra solo
          // manualmente para que el operador pueda leer tranquilo. Los datos
          // del cliente persisten en `this.cliente` — al re-abrir el diálogo
          // de pedido, el formulario sigue lleno.
          this.mostrarConfirmacion.set(false);
          this.excedidosStock.set(excedidos);
          this.mostrarDialogExcedidos.set(true);
          return;
        }

        // Stock OK (sin importar si cambió el precio en DUX) → enviar.
        this.enviarPedido();
      },
      error: (err) => {
        this.refrescando.set(false);
        // Si DUX no responde, mandamos el pedido igual con los datos del cache.
        // DUX validará al recibirlo — si rechaza, mostramos el error.
        this.toast.add({
          severity: 'warn',
          summary: 'No se pudo verificar stock',
          detail: 'Enviando el pedido igual; DUX validará al recibirlo.',
          life: 4000,
        });
        console.warn('[confirmarEnvio] refresh failed:', err);
        this.enviarPedido();
      },
    });
  }

  /** Manda el pedido a DUX con los datos actuales del carrito y del cliente.
   *  Asume que las validaciones (stock, datos requeridos) ya fueron OK. */
  private enviarPedido(): void {
    const c = this.cliente();
    this.enviando.set(true);
    this.api
      .crearPedido({
        // `apellido_razon_social` (obligatorio en DUX) siempre es el placeholder fijo:
        // la operadora lo edita en DUX al asociar el comprobante con el cliente real.
        apellidoRazonSocial: APELLIDO_RAZON_SOCIAL,
        // "Nombre y apellido" del cliente real → DUX `nombre` (opcional).
        nombre: c.nombre.trim() || undefined,
        categoriaFiscal: this.categoriaFiscalFinal,
        tipoDoc: 'CUIT',
        nroDoc: c.nroDoc ?? undefined,
        telefono: c.telefono.trim() || undefined,
        email: c.email.trim() || undefined,
        domicilio: c.domicilio.trim() || undefined,
        codigoProvincia: c.codigoProvincia ?? undefined,
        idLocalidad: c.idLocalidad ?? undefined,
        observaciones: c.observaciones.trim() || undefined,
        // Forma de pago elegida en el carrito (null si "Efectivo" / sin
        // selección). El backend aplica el recargo % a cada precioUnitario
        // antes de mandar a DUX.
        formaPagoId: this.formaPagoSeleccionada()?.id ?? undefined,
        items: this.carrito().map((it) => ({
          sku: it.sku,
          cantidad: it.cantidad,
          // Mandamos el precio CON IVA: la lista "KT GASTRO" en DUX está configurada
          // como "incluye IVA", entonces DUX espera valores con-IVA y descuenta el IVA
          // internamente. Si mandamos sin-IVA, DUX lo trata como con-IVA y queda mal.
          // El display en el showroom sigue mostrando sin-IVA al operador (informativo).
          precioUnitario: it.pvpKtGastroConIva,
          descuentoPorcentaje: this.descuentoAplicado() || undefined,
        })),
      })
      .subscribe({
        next: (res) => {
          this.enviando.set(false);
          this.mostrarConfirmacion.set(false);
          if (res.estado === 'ENVIADO') {
            this.toast.add({
              severity: 'success',
              summary: 'Pedido cargado en DUX',
              detail: res.mensaje,
              life: 5000,
            });
            this.vaciarCarrito();
            this.cliente.set({ ...CLIENTE_VACIO });
            // Reset de la forma de pago al default (primera de la lista) — el
            // próximo cliente arranca con el método configurado por el operador.
            const formas = this.formasPagoActivas();
            this.formaPagoSeleccionada.set(formas.length > 0 ? formas[0] : null);
            // Dialog post-pedido para que el cliente nos califique en Google
            // (la imagen incluye el QR pre-generado, ver public/opinion-google.png).
            this.mostrarDialogReview.set(true);
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
          this.enviando.set(false);
          toastError(this.toast, 'Pedido', err, 'Error al enviar pedido');
        },
      });
  }

  trackBySku = (_: number, it: CarritoItem) => it.sku;
}

const ESCALA_COLOR_SCHEMES = [
  {
    border: 'border-amber-300 dark:border-amber-700',
    bg: 'bg-gradient-to-br from-amber-50 to-amber-100/50 dark:from-amber-950/40 dark:to-amber-900/20',
    pill: 'bg-amber-500',
    textTitle: 'text-amber-800 dark:text-amber-300',
    textBig: 'text-amber-700 dark:text-amber-300',
    textSmall: 'text-amber-700/80 dark:text-amber-300/80',
    textItalic: 'text-amber-800/70 dark:text-amber-300/70',
  },
  {
    border: 'border-emerald-400 dark:border-emerald-700',
    bg: 'bg-gradient-to-br from-emerald-50 to-emerald-100/50 dark:from-emerald-950/40 dark:to-emerald-900/20',
    pill: 'bg-emerald-600',
    textTitle: 'text-emerald-800 dark:text-emerald-300',
    textBig: 'text-emerald-700 dark:text-emerald-300',
    textSmall: 'text-emerald-700/80 dark:text-emerald-300/80',
    textItalic: 'text-emerald-800/70 dark:text-emerald-300/70',
  },
  {
    border: 'border-sky-400 dark:border-sky-700',
    bg: 'bg-gradient-to-br from-sky-50 to-sky-100/50 dark:from-sky-950/40 dark:to-sky-900/20',
    pill: 'bg-sky-600',
    textTitle: 'text-sky-800 dark:text-sky-300',
    textBig: 'text-sky-700 dark:text-sky-300',
    textSmall: 'text-sky-700/80 dark:text-sky-300/80',
    textItalic: 'text-sky-800/70 dark:text-sky-300/70',
  },
  {
    border: 'border-violet-400 dark:border-violet-700',
    bg: 'bg-gradient-to-br from-violet-50 to-violet-100/50 dark:from-violet-950/40 dark:to-violet-900/20',
    pill: 'bg-violet-600',
    textTitle: 'text-violet-800 dark:text-violet-300',
    textBig: 'text-violet-700 dark:text-violet-300',
    textSmall: 'text-violet-700/80 dark:text-violet-300/80',
    textItalic: 'text-violet-800/70 dark:text-violet-300/70',
  },
  {
    border: 'border-rose-400 dark:border-rose-700',
    bg: 'bg-gradient-to-br from-rose-50 to-rose-100/50 dark:from-rose-950/40 dark:to-rose-900/20',
    pill: 'bg-rose-600',
    textTitle: 'text-rose-800 dark:text-rose-300',
    textBig: 'text-rose-700 dark:text-rose-300',
    textSmall: 'text-rose-700/80 dark:text-rose-300/80',
    textItalic: 'text-rose-800/70 dark:text-rose-300/70',
  },
] as const;
