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
import { RouterLink } from '@angular/router';
import { EMPTY, Subject, Subscription, firstValueFrom } from 'rxjs';
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
import { CarritoItem, CatalogoItem, CategoriaFiscal, EscalaDescuento, FormaPago, Localidad, Provincia, ScanResult, SesionShowroom, normalizarRubro } from '../models';
import { calcularSugerenciasEmail } from '../email-suggestions.utils';
import { precioPorForma, iconoFormaReferencia } from '../precio-referencia.util';
import { ShowroomService } from '../showroom.service';
import { SyncStateService } from '../sync-state.service';
import { toastError } from '../toast.utils';
import {
  ProductoGenericoData,
  ProductoGenericoDialog,
} from '../producto-generico-dialog/producto-generico-dialog';
import { TopActions } from '../top-actions/top-actions';

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
  /** Rubro comercial del cliente — obligatorio desde mayo 2026 al crear el
   *  pedido. Valor es el ID de la opción ({@code 'bar'}, {@code 'restaurant'},
   *  etc.) o {@code 'otros'} cuando el operador eligió texto libre. Si es
   *  {@code 'otros'}, el texto real va en {@link rubroOtros}. */
  rubro: string | null;
  /** Texto libre cuando {@link rubro} === 'otros'. Se envía al backend
   *  resuelto: si rubro es una opción predefinida se manda esa; si es
   *  'otros' se manda este texto. */
  rubroOtros: string;
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
  rubro: null,
  rubroOtros: '',
  domicilio: '',
  codigoProvincia: null,
  idLocalidad: null,
  observaciones: '',
};

/** Opciones del dropdown de rubro — mismas que /presupuestos para coherencia.
 *  'otros' habilita un input libre. */
const OPCIONES_RUBRO: { label: string; value: string }[] = [
  { label: 'Bar', value: 'bar' },
  { label: 'Restaurant', value: 'restaurant' },
  { label: 'Catering', value: 'catering' },
  { label: 'Cafetería', value: 'cafeteria' },
  { label: 'Panadería', value: 'panaderia' },
  { label: 'Pastelería', value: 'pasteleria' },
  { label: 'Otros…', value: 'otros' },
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
    ProductoGenericoDialog,
    TopActions,
  ],
  templateUrl: './showroom-page.html',
  styleUrl: './showroom-page.scss',
})
export class ShowroomPage implements AfterViewInit {
  private readonly api = inject(ShowroomService);
  private readonly auth = inject(AuthService);
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

  /** Estado del dialog "+ Producto genérico" — para cargar al carrito un
   *  ítem que no existe en el catálogo KT GASTRO (usa el SKU comodín de DUX
   *  expuesto en /health). El botón en el toolbar se oculta si el backend
   *  no expuso el SKU (versión vieja). */
  readonly mostrarDialogGenerico = signal(false);
  /** True mientras la request POST /carrito/generico está en vuelo — el dialog
   *  lo lee para deshabilitar el botón "Agregar" y mostrar el spinner. */
  readonly procesandoGenerico = signal(false);
  /** SKU comodín — el template lo lee para mostrar/ocultar el botón. */
  readonly skuGenerico = this.backendStatus.skuProductoGenerico;
  readonly iniciandoSesion = signal(false);
  /** Updates de cantidad — debounceadas por SKU para que clickear +/- rápido
   *  no dispare un PATCH por click. El último valor por SKU dentro del
   *  intervalo es el que viaja al backend. La suscripción se arma en el
   *  constructor. */
  private readonly cantidadUpdates$ = new Subject<{ itemKey: string; cantidad: number }>();
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

  // menuExtras vive ahora en <app-more-menu /> (componente reusable) — sin
  // esto se duplicaba la lista en cada toolbar que quería el botón "Más".

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

  /** Forma destacada menaje por defecto (menor `orden`), o null. Fallback para
   *  el precio cuando no hay forma efectiva resuelta. */
  readonly formaReferenciaPrimaria = computed(() => this.formaDestacada(false));

  /** Forma destacada/default para el perfil del producto: de las formas activas
   *  marcadas como referencia de ese perfil (menaje → `precioReferencia`;
   *  maquinaria → `precioReferenciaMaquinaria`), la de menor `orden`. Null si
   *  ninguna marcada (entonces se cae al precio de lista según rubro). Mismo
   *  criterio que el presupuestador. */
  formaDestacada(esMaquinaria: boolean): FormaPago | null {
    return this.formasPagoActivas()
      .filter((f) => (esMaquinaria ? f.precioReferenciaMaquinaria : f.precioReferencia))
      .sort((a, b) => (a.orden ?? 0) - (b.orden ?? 0))[0] ?? null;
  }

  /** Forma elegida por el operador en el selector del scan (sticky). Mientras
   *  sea null, el precio mostrado usa la {@link formaDestacada} del rubro del
   *  producto escaneado; al elegir una se mantiene entre productos. */
  readonly formaScanSeleccionada = signal<FormaPago | null>(null);

  /** Forma EFECTIVA del scan = la elegida por el operador, o la destacada del
   *  perfil del producto escaneado si todavía no eligió ninguna. */
  readonly formaScanEfectiva = computed<FormaPago | null>(() => {
    const elegida = this.formaScanSeleccionada();
    if (elegida) return elegida;
    return this.formaDestacada(this.rubroCotizaSinIva(this.ultimoScan()?.rubro));
  });

  /** Rubros cuyos productos cotizan sin IVA (precio base = PVP sin IVA). Se cargan
   *  al iniciar; default del backend = MAQUINAS INDUSTRIALES. */
  readonly rubrosSinIva = signal<string[]>([]);

  /** Set normalizado para comparar rubros sin importar acentos/casing. */
  private readonly rubrosSinIvaSet = computed(
    () => new Set(this.rubrosSinIva().map(normalizarRubro)),
  );

  /** True si el rubro cotiza sin IVA (su precio base es el PVP sin IVA). */
  rubroCotizaSinIva(rubro: string | null | undefined): boolean {
    const n = normalizarRubro(rubro);
    return n !== '' && this.rubrosSinIvaSet().has(n);
  }

  /** Escalones ordenados de mayor a menor umbral — útil para resolver el escalón vigente. */
  private readonly escalasDesc = computed(() =>
    [...this.escalasDescuento()].sort((a, b) => b.umbralMin - a.umbralMin),
  );

  /** Escalones ordenados de menor a mayor umbral — orden natural para mostrar
   *  los tiles "comprá más" (el más cercano primero, los mejores al final). */
  readonly escalasOrdenadas = computed(() =>
    [...this.escalasDescuento()].sort((a, b) => a.umbralMin - b.umbralMin),
  );

  /** True si el ítem pertenece a un rubro de maquinaria (lista configurable).
   *  Esos ítems NO suman al umbral del escalón ni reciben el descuento por
   *  escala — el cliente los paga al PVP de lista. Mismo grupo que usa el
   *  perfil "maquinaria" de las formas de pago. */
  private rubroExcluido(it: { rubro?: string | null }): boolean {
    return this.rubroCotizaSinIva(it.rubro);
  }

  /** True si el ítem queda fuera del descuento por escala. Hoy depende solo
   *  del rubro (MAQUINAS INDUSTRIALES), inclusive para genéricos: el dialog
   *  "+ Producto genérico" tiene un toggle "Es maquinaria" que el backend
   *  traduce a {@code rubro=MAQUINAS INDUSTRIALES}, así que la misma helper
   *  cubre ambos casos. Los genéricos sin esa marca entran en la escala
   *  como cualquier producto del catálogo. */
  private excluidoDescuentoEscala(it: { rubro?: string | null; generico?: boolean }): boolean {
    return this.rubroExcluido(it);
  }

  /** Suma del PVP s/IVA por cantidad, sin aplicar descuento. Es el "subtotal"
   *  visible en el carrito (incluye TODOS los ítems, también los excluidos
   *  de descuento). */
  readonly subtotalPreDescuento = computed(() =>
    this.carrito().reduce(
      (acc, it) => acc + (it.pvpKtGastroSinIva ?? 0) * it.cantidad,
      0,
    ),
  );

  /** Subtotal s/IVA contando SOLO los ítems elegibles para el descuento por
   *  escala. Es la base sobre la que se compara el umbral y sobre la que se
   *  aplica el %. Los ítems excluidos (ej. MAQUINAS INDUSTRIALES) no
   *  empujan el escalón ni reciben el descuento. */
  readonly subtotalElegibleDescuento = computed(() =>
    this.carrito()
      .filter((it) => !this.excluidoDescuentoEscala(it))
      .reduce((acc, it) => acc + (it.pvpKtGastroSinIva ?? 0) * it.cantidad, 0),
  );

  /** Descuento % vigente según el subtotal elegible y los escalones configurados. */
  readonly descuentoAplicado = computed(() => {
    const sub = this.subtotalElegibleDescuento();
    const aplicable = this.escalasDesc().find((e) => sub >= e.umbralMin);
    return aplicable?.porcentaje ?? 0;
  });

  /**
   * Descuentos manuales por ítem del carrito (FASE 4). El carrito es estado del
   * backend (single source of truth), así que para NO tocar el modelo del carrito
   * en el backend mantenemos el descuento manual como estado LOCAL del componente:
   * un mapa `itemKey → %` (0..100). Vive solo mientras dura la atención al cliente
   * — al vaciar el carrito o enviar el pedido se limpia.
   *
   * Regla "manual reemplaza escala" (por ítem): si un ítem tiene manual > 0, ese
   * ítem usa el manual y se ignora el descuento automático por escala; si el
   * manual es 0 (o no existe), sigue aplicando la escala como hoy. Ver
   * {@link descuentoParaItem}.
   */
  readonly descuentosManuales = signal<Record<string, number>>({});

  /** % de descuento manual cargado para un ítem (0 si no tiene). */
  descuentoManual(itemKey: string): number {
    return this.descuentosManuales()[itemKey] ?? 0;
  }

  /** Setea el descuento manual % de un ítem (0..100). 0 lo borra del mapa para
   *  que vuelva a regir la escala automática en esa línea. */
  setDescuentoManual(itemKey: string, valor: number | null | undefined): void {
    let v = Number(valor);
    if (!Number.isFinite(v) || v < 0) v = 0;
    if (v > 100) v = 100;
    const actual = { ...this.descuentosManuales() };
    if (v > 0) actual[itemKey] = v;
    else delete actual[itemKey];
    this.descuentosManuales.set(actual);
  }

  /**
   * Descuento global manual % (atajo) — al cambiarlo, COPIA el mismo % a TODOS
   * los ítems del carrito (reflejo, no aditivo; igual que el presupuestador). El
   * input lo muestra como reflejo del % EFECTIVO ({@link descuentoEfectivoPct}):
   * cuando todos los ítems llevan el mismo descuento coincide con ese %; con una
   * mezcla muestra el promedio efectivo. No es un descuento que se suma encima
   * de los individuales.
   */
  aplicarDescuentoGlobal(valor: number | null | undefined): void {
    let v = Number(valor);
    if (!Number.isFinite(v) || v < 0) v = 0;
    if (v > 100) v = 100;
    const mapa: Record<string, number> = {};
    if (v > 0) {
      for (const it of this.carrito()) mapa[it.itemKey] = v;
    }
    this.descuentosManuales.set(mapa);
    this.focusInput();
  }

  /** % de descuento EFECTIVO que aplica a un ítem individual.
   *  - Manual > 0 → ese ítem usa el manual y se ignora la escala (incluso para
   *    rubros normalmente excluidos: el operador lo cargó a mano a propósito).
   *  - Manual 0/ausente → escala automática para los elegibles, 0 para los
   *    excluidos (por rubro o por ser genérico). */
  private descuentoParaItem(it: { itemKey?: string; rubro?: string | null; generico?: boolean }): number {
    const manual = it.itemKey ? this.descuentoManual(it.itemKey) : 0;
    if (manual > 0) return manual;
    return this.excluidoDescuentoEscala(it) ? 0 : this.descuentoAplicado();
  }

  /** % de descuento EFECTIVO de un ítem del carrito (manual o escala) — para
   *  mostrar el badge por línea en el template. */
  descuentoEfectivoItem(it: CarritoItem): number {
    return this.descuentoParaItem(it);
  }

  /** True si el descuento efectivo de la línea proviene de un manual cargado a
   *  mano (no de la escala) — el template lo usa para diferenciar el badge. */
  itemTieneDescuentoManual(it: CarritoItem): boolean {
    return this.descuentoManual(it.itemKey) > 0;
  }

  /** Monto total de descuento (en pesos) — suma del descuento EFECTIVO por ítem
   *  (manual o escala) sobre toda la lista. */
  readonly descuentoMonto = computed(() =>
    this.carrito().reduce((acc, it) => {
      const base = (it.pvpKtGastroSinIva ?? 0) * it.cantidad;
      return acc + (base * this.descuentoParaItem(it)) / 100;
    }, 0),
  );

  readonly totalCarrito = computed(
    () => this.subtotalPreDescuento() - this.descuentoMonto(),
  );

  /** % de descuento EFECTIVO sobre el subtotal completo del carrito (mezcla de
   *  manuales por ítem y escala). Es lo que se muestra en el desglose del total
   *  — reemplaza al viejo {@link descuentoAplicado} (puro escala) en el display
   *  ahora que cada línea puede tener su propio %. 0 si no hay ningún descuento. */
  readonly descuentoEfectivoPct = computed(() => {
    const bruto = this.subtotalPreDescuento();
    if (bruto <= 0) return 0;
    return (this.descuentoMonto() / bruto) * 100;
  });

  /** True si en el carrito hay AL MENOS un ítem con descuento manual cargado. */
  readonly hayDescuentoManual = computed(() =>
    this.carrito().some((it) => this.descuentoManual(it.itemKey) > 0),
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

  /** Ajuste de la forma de pago sobre el subtotal sin IVA: positivo = recargo de
   *  financiación, negativo = descuento (ej. Efectivo -13%). Per-ítem, con el
   *  descuento por escala aplicado. */
  readonly recargoMontoSinIva = computed(() => {
    const fp = this.formaPagoSeleccionada();
    if (!fp) return 0;
    return this.carrito().reduce((acc, it) => {
      const recargo = this.perfilForma(fp, this.rubroCotizaSinIva(it.rubro)).recargoPorcentaje ?? 0;
      if (recargo === 0) return acc;
      const factorExtra = this.factorForma(recargo) - 1;
      const descuento = this.descuentoParaItem(it);
      const baseSinIva = (it.pvpKtGastroSinIva ?? 0) * (1 - descuento / 100);
      return acc + baseSinIva * factorExtra * it.cantidad;
    }, 0);
  });

  /** IVA contenido en el total. Per-ítem: solo los ítems cuyo perfil (según rubro
   *  y forma elegida) lleva IVA. Se calcula sobre el neto con el recargo del
   *  perfil aplicado. */
  readonly ivaMontoCarrito = computed(() => {
    const fp = this.formaPagoSeleccionada();
    return this.carrito().reduce((acc, it) => {
      if (!this.itemCarritoTieneIva(it)) return acc;
      const porcIva = it.porcIva ?? 0;
      if (porcIva <= 0) return acc;
      const recargo = fp ? (this.perfilForma(fp, this.rubroCotizaSinIva(it.rubro)).recargoPorcentaje ?? 0) : 0;
      const factor = this.factorForma(recargo);
      const descuento = this.descuentoParaItem(it);
      const baseSinIva = (it.pvpKtGastroSinIva ?? 0) * (1 - descuento / 100);
      const netoConForma = baseSinIva * factor;
      return acc + netoConForma * (porcIva / 100) * it.cantidad;
    }, 0);
  });

  /** Total final que el cliente paga: subtotal + recargo (sin IVA) + IVA (si la
   *  forma aplica). Equivale a {@code base × (aplicaIva ? (1+iva/100) : 1) / (1 - recargo/100)}
   *  per-item. */
  readonly totalConRecargo = computed(
    () => this.totalCarrito() + this.recargoMontoSinIva() + this.ivaMontoCarrito(),
  );

  /** Total final del carrito para una forma de pago dada — usado en el dialog
   *  "comparativa de formas de pago" que el operador le muestra al cliente.
   *  Descuento per-item para que los rubros excluidos (MAQUINAS INDUSTRIALES)
   *  no reciban la rebaja por escala. */
  totalParaForma(fp: FormaPago): number {
    return this.carrito().reduce((acc, it) => {
      const descuento = this.descuentoParaItem(it);
      const unit = this.precioReferenciaPorForma(it, fp) * (1 - descuento / 100);
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

  /** True si el producto recién escaneado pertenece a un rubro excluido de
   *  los descuentos por escala (MAQUINAS INDUSTRIALES). Se usa para ocultar
   *  los tiles "Comprá más y ahorrás" debajo del scan — esos tiles
   *  sugerirían un precio que comercialmente no aplica al producto. */
  readonly scanExcluyeDescuentos = computed(
    () => this.rubroCotizaSinIva(this.ultimoScan()?.rubro),
  );

  /** True si el ítem (resultado de búsqueda o ítem de carrito) es de un
   *  rubro excluido. El template lo usa para mostrar el badge "MÁQUINA
   *  INDUSTRIAL" en cada fila — el operador identifica de un vistazo qué
   *  productos no califican para descuentos por escala. */
  esRubroSinDescuento(rubro: string | null | undefined): boolean {
    return this.rubroCotizaSinIva(rubro);
  }

  /** True si en el carrito hay AL MENOS un ítem de rubro excluido. El UI lo
   *  usa para aclarar que el descuento mostrado no se aplica a todos los
   *  ítems (sólo a los elegibles). Sin esta aclaración el operador podría
   *  confundirse al ver que el monto del descuento es menor del que esperaría
   *  multiplicando subtotal × %. */
  readonly carritoTieneRubroExcluido = computed(
    () => this.carrito().some((it) => this.rubroCotizaSinIva(it.rubro)),
  );

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

  /** Ícono de la forma de pago. Cuotas → tarjeta (señal inequívoca de
   *  financiación). El resto se infiere del nombre (efectivo, transferencia…)
   *  con la misma heurística que los precios de referencia, para no mostrar
   *  todas las formas de pago contado con el mismo ícono. */
  iconoForma(fp: FormaPago): string {
    if (fp.cantidadCuotas && fp.cantidadCuotas > 1) return 'pi pi-credit-card';
    return iconoFormaReferencia(fp.nombre);
  }

  readonly cantidadTotal = computed(() =>
    this.carrito().reduce((acc, it) => acc + it.cantidad, 0),
  );

  /** Precio unitario efectivo aplicando el descuento global vigente. Los
   *  ítems de rubros excluidos (MAQUINAS INDUSTRIALES) mantienen el PVP. */
  precioEfectivo(it: CarritoItem): number {
    const base = it.pvpKtGastroSinIva ?? 0;
    return base * (1 - this.descuentoParaItem(it) / 100);
  }

  /** Subtotal de la línea SIN descuento por escala, al precio de la forma de pago
   *  elegida (mismo precio que se muestra como c/u). El descuento por escala se
   *  muestra solo a nivel total. */
  subtotal(it: CarritoItem): number {
    return this.precioItemForma(it) * it.cantidad;
  }

  /** Próximo escalón a alcanzar (umbralMin > subtotal elegible actual), o
   *  null si ya está en el tope. Usa el subtotal de ítems ELEGIBLES — los
   *  excluidos por rubro no empujan el escalón. */
  private readonly proximoEscalonObj = computed(() => {
    const sub = this.subtotalElegibleDescuento();
    return this.escalasDescuento().find((e) => sub < e.umbralMin) ?? null;
  });

  /** Pesos que faltan para llegar al próximo escalón — null si ya está en el tope. */
  readonly faltaParaProximo = computed(() => {
    const proximo = this.proximoEscalonObj();
    return proximo ? proximo.umbralMin - this.subtotalElegibleDescuento() : null;
  });

  /** % del próximo escalón al que se llegaría, null si ya está en el tope. */
  readonly proximoEscalon = computed(() => this.proximoEscalonObj()?.porcentaje ?? null);

  /** Datos para el {@code p-meterGroup} del carrito: visualiza qué tan cerca
   *  está el subtotal del próximo umbral de descuento. Null cuando ya estás
   *  en el tope (no hay próximo escalón). */
  readonly meterProximoEscalon = computed(() => {
    const proximo = this.proximoEscalonObj();
    if (!proximo) return null;
    const sub = this.subtotalElegibleDescuento();
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

  /** Recargo + aplicaIva del perfil (Normal o Maquinaria) de una forma según el
   *  rubro. Maquinaria: recargo null → 0 (no hereda del normal); aplicaIva null → false. */
  perfilForma(forma: FormaPago, esMaquinaria: boolean): { recargoPorcentaje: number | null; aplicaIva: boolean | null } {
    if (esMaquinaria) {
      return {
        recargoPorcentaje: forma.recargoPorcentajeMaquinaria ?? 0,
        aplicaIva: forma.aplicaIvaMaquinaria ?? false,
      };
    }
    return { recargoPorcentaje: forma.recargoPorcentaje, aplicaIva: forma.aplicaIva };
  }

  /** Precio de referencia de un producto (scan o ítem de carrito) para una forma
   *  de pago dada. Siempre parte del PVP con IVA; el perfil (Normal/Maquinaria)
   *  del rubro decide el recargo y si lleva IVA. */
  precioReferenciaPorForma(
    r: { pvpKtGastroConIva: number | null; pvpKtGastroSinIva: number | null; porcIva: number | null; rubro?: string | null },
    forma: FormaPago,
  ): number {
    const perfil = this.perfilForma(forma, this.rubroCotizaSinIva(r.rubro));
    return precioPorForma(r.pvpKtGastroConIva, r.porcIva, perfil);
  }

  /** Ícono PrimeNG para una forma de pago de referencia (inferido del nombre). */
  iconoPrecioReferencia(nombre: string): string {
    return iconoFormaReferencia(nombre);
  }

  /** Factor del recargo/descuento de la forma sobre el neto. >0 financiación
   *  (1/(1-r/100)); <0 descuento (1+r/100 = 1-|r|/100); 0 sin cambio. */
  private factorForma(recargo: number): number {
    if (recargo > 0) return 1 / (1 - recargo / 100);
    if (recargo < 0) return 1 + recargo / 100;
    return 1;
  }

  /** Precio unitario de un ítem del carrito según la forma elegida (o la primaria
   *  si no hay forma seleccionada) y el rubro. */
  precioItemForma(it: CarritoItem): number {
    const fp = this.formaPagoSeleccionada();
    return fp ? this.precioReferenciaPorForma(it, fp) : this.precioReferenciaPrimario(it);
  }

  /** True si el precio del ítem para la forma elegida lleva IVA, según el perfil
   *  (Normal/Maquinaria) de su rubro. */
  itemCarritoTieneIva(it: { rubro?: string | null }): boolean {
    const fp = this.formaPagoSeleccionada();
    if (!fp) return this.aplicaIvaCliente();
    return this.precioReferenciaTieneIva(it, fp);
  }

  /** True si el precio mostrado para esta forma incluye IVA, según el perfil del
   *  rubro: maquinaria usa `aplicaIvaMaquinaria` (null→false); el resto `aplicaIva`. */
  precioReferenciaTieneIva(
    r: { rubro?: string | null },
    forma: FormaPago,
  ): boolean {
    return this.perfilForma(forma, this.rubroCotizaSinIva(r.rubro)).aplicaIva ?? true;
  }

  /** Clases del badge c/IVA (verde) o s/IVA (ámbar), reusando la paleta de la
   *  tabla de formas de pago. */
  badgeIvaClass(tieneIva: boolean): string {
    return tieneIva
      ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
      : 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300';
  }

  /** Precio de la forma de referencia primaria. Si no hay formas marcadas, cae al
   *  precio base según el rubro (PVP sin IVA para rubros sin IVA, con IVA el resto). */
  precioReferenciaPrimario(
    r: { pvpKtGastroConIva: number | null; porcIva: number | null; pvpKtGastroSinIva: number | null; rubro?: string | null },
  ): number {
    const f = this.formaReferenciaPrimaria();
    if (f) return this.precioReferenciaPorForma(r, f);
    return this.rubroCotizaSinIva(r.rubro)
      ? (r.pvpKtGastroSinIva ?? 0)
      : (r.pvpKtGastroConIva ?? r.pvpKtGastroSinIva ?? 0);
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

  /** Tope de cantidad para los InputNumber. NO se topea al stock: se permite
   *  pedir más de lo disponible (el excedente queda como pendiente de
   *  reposición y el ítem se agrega "forzado"). Cap alto solo para evitar
   *  cantidades absurdas. */
  maxCantidad(_stock?: number | null | undefined): number {
    return 9999;
  }

  /** True cuando una cantidad supera el stock disponible conocido. Solo para
   *  un aviso INFORMATIVO (no bloquea agregar). */
  superaStock(stock: number | null | undefined, cantidad: number): boolean {
    return stock != null && stock > 0 && cantidad > stock;
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
      // Desde mayo 2026 también son obligatorios nombre, teléfono y rubro.
      // Si el operador elige "Otros" en rubro, tiene que cargar el texto libre.
      c.nombre.trim().length > 0 &&
      c.telefono.trim().length > 0 &&
      this.rubroValido(c) &&
      this.carrito().length > 0
    );
  });

  /** Opciones del dropdown de rubro — expuestas para el template. */
  readonly opcionesRubro = OPCIONES_RUBRO;

  /** True si el cliente cargó un rubro válido: una opción predefinida, o
   *  "Otros" con texto libre no vacío. */
  rubroValido(c: DatosCliente): boolean {
    if (!c.rubro) return false;
    if (c.rubro === 'otros') return c.rubroOtros.trim().length > 0;
    return true;
  }

  /** Resuelve el valor final del rubro para el payload del backend: si el
   *  operador eligió "otros" se manda el texto libre; sino, la opción
   *  predefinida. */
  rubroFinal(): string {
    const c = this.cliente();
    if (c.rubro === 'otros') return c.rubroOtros.trim();
    return c.rubro ?? '';
  }

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

  /** Valor (string) que ve el inputMask del teléfono: solo dígitos del teléfono
   *  guardado, para que la máscara `99-99999999` aplique el guión sola. Sirve
   *  para limpiar valores legacy que tenían guiones u otros chars antes de
   *  migrar al inputMask. */
  readonly telefonoInputValue = computed(() => {
    const t = this.cliente().telefono;
    return t ? t.replace(/\D/g, '') : '';
  });

  /** Recibe el valor del inputMask con [unmask]="true" — solo dígitos. Lo convertimos
   *  a number para que el resto del flujo (validación, payload a DUX) siga igual. */
  onCuitChange(value: string | null | undefined): void {
    const digits = (value ?? '').replace(/\D/g, '');
    this.actualizarCliente('nroDoc', digits ? Number(digits) : null);
  }

  /** Recibe el valor del inputMask del teléfono con [unmask]="true" (solo dígitos).
   *  Lo guarda tal cual en el cliente — el formato visual con guión lo provee
   *  la máscara, no la data persistida. */
  onTelefonoChange(value: string | null | undefined): void {
    this.actualizarCliente('telefono', value ?? '');
  }

  constructor() {
    // Carga los escalones de descuento desde el backend al iniciar. Si la
    // request falla, la signal queda vacía → no se aplica ningún descuento
    // (default seguro: el operador siempre puede vender al precio de lista).
    this.api.obtenerEscalasDescuento()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (lista) => this.escalasDescuento.set(lista),
        error: (err) =>
          console.warn('[escalas-descuento] no se pudieron cargar:', err),
      });

    // Rubros que cotizan sin IVA — definen qué productos usan el PVP sin IVA como
    // precio base. Si falla, queda lista vacía (todos cotizan con IVA).
    this.api.obtenerRubrosSinIva()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (lista) => this.rubrosSinIva.set(lista),
        error: (err) =>
          console.warn('[rubros-sin-iva] no se pudieron cargar:', err),
      });

    // Formas de pago activas — para el selector del carrito. La primera de la
    // lista (orden asc) queda seleccionada por default — el operador la
    // configuró como "default" desde /configuracion (p.ej. Efectivo).
    this.api.listarFormasPagoActivas()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
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
    this.api.obtenerCarrito()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (state) => this.carrito.set(state.items),
        error: (err) => console.warn('[carrito] no se pudo hidratar:', err),
      });

    // Hidratación inicial de la sesión activa. Si había una en curso, la
    // levantamos para pre-llenar el form y mostrar el badge en el header.
    // Si no hay sesión activa (carga limpia / reinicio / cliente recién
    // terminado), abrimos el modal de "Nuevo cliente" automáticamente para
    // que el operador identifique al cliente antes de empezar a escanear.
    this.api.obtenerSesionActiva()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
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
            this.procesarCambioDesdeVisor(previo, state.items);
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
        groupBy((u) => u.itemKey),
        mergeMap((porKey) =>
          porKey.pipe(
            debounceTime(250),
            switchMap((u) =>
              this.api.actualizarCantidadItemCarrito(u.itemKey, u.cantidad).pipe(
                tap((state) => {
                  const item = state.items.find((it) => it.itemKey === u.itemKey);
                  if (item && item.cantidad < u.cantidad) {
                    // Recortado por stock — el server tiene menos disponible
                    // que lo que pidió el user. Aceptamos siempre (el max del
                    // stepper se va a actualizar al nuevo stock) y avisamos.
                    this.toast.add({
                      severity: 'warn',
                      summary: 'Cantidad ajustada al stock',
                      detail: `${item.sku}: tope ${item.cantidad} unidades.`,
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

    // Cancela la request de localidades en vuelo cuando el componente se
    // destruye. No es un leak crítico (la respuesta sería ignorada igual),
    // pero evita el warning de Angular Zoneless sobre observables huérfanos.
    this.destroyRef.onDestroy(() => this.localidadesSub?.unsubscribe());

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
        this.mostrarSyncDialog() ||
        this.mostrarDialogGenerico();
      if (dialogAbiertoPrevio && !algunoAbierto) {
        this.focusInput();
      }
      dialogAbiertoPrevio = algunoAbierto;
    });

    const refocus = (e: MouseEvent) => {
      if (this.mostrarConfirmacion()) return;
      const target = e.target as HTMLElement | null;
      // Click dentro de un toast (incluido el botón X de cerrar) → refocusear
      // el scan input. El operador acaba de descartar una notificación y
      // necesita poder seguir escaneando inmediatamente sin tener que
      // clickear el input. Este check va ANTES del exclusión general de
      // botones, sino el click en la X cae como "click en button" y no
      // refocusea.
      if (target?.closest('.p-toast')) {
        this.focusInput();
        return;
      }
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

  /** El operador eligió una forma en el selector del scan. Queda sticky y se
   *  refleja en el visor del cliente. Devuelve el foco al input para seguir
   *  escaneando. */
  onCambiarFormaScan(fp: FormaPago | null): void {
    this.formaScanSeleccionada.set(fp);
    this.publicarFormaEnVisor();
    this.focusInput();
  }

  /** Publica la forma EFECTIVA del scan al visor del operador (SSE
   *  `visor-forma`). Best-effort: si la request falla, solo lo logueamos — la
   *  pantalla del operador no depende de esto. No publica si no hay forma
   *  efectiva (sin formas marcadas) ni id. */
  private publicarFormaEnVisor(): void {
    const forma = this.formaScanEfectiva();
    if (forma?.id == null) return;
    this.api.publicarFormaVisor(forma.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        error: (err) => console.warn('[visor-forma] no se pudo publicar:', err),
      });
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

  /** QR (data URL) del visor del operador logueado — se genera al abrir el
   *  dialog. Apunta a {@code /visor/{username}} sobre la base configurada en
   *  /configuracion (o el host actual si no hay ninguna), así cada operador
   *  tiene un QR único que enlaza a su canal personal del visor. Si el QR aún
   *  no se generó (dialog nunca abierto), queda null. */
  readonly qrVisorDataUrl = signal<string | null>(null);

  /** True mientras se está generando el QR del visor. Permite distinguir en el
   *  HTML el estado "cargando" (spinner) del estado "falló" (URL como texto de
   *  fallback) — sin esto, un fallo dejaba el spinner girando para siempre. */
  readonly qrVisorGenerando = signal(false);

  /** URL base configurada en /configuracion para el QR del visor. Vacío → se usa
   *  `window.location.origin`. Sirve para cuando el operador entra a la app por
   *  hostname/DNS (ej. "servidor") que los celulares no resuelven: con la IP
   *  configurada el QR queda alcanzable desde el celular del cliente. Se refresca
   *  al abrir el dialog. */
  private readonly visorBaseConfig = signal('');

  /**
   * Abre el dialog "QR para celular" y genera (perezosamente) el QR del visor
   * del operador logueado. La URL usa la base configurada en /configuracion
   * (campo "Dirección del visor"); si no hay ninguna, cae al host actual.
   *
   * <p>El QR y la base se refrescan en cada apertura para que, si el operador
   * cambia de cuenta (logout + login), si se editó la dirección configurada, o
   * si la app se sirve detrás de hostnames distintos (LAN vs. túnel), siempre
   * refleje la URL correcta.
   */
  async abrirDialogVisor(): Promise<void> {
    this.mostrarDialogVisor.set(true);
    const username = this.auth.currentUser()?.username;
    if (!username || typeof window === 'undefined') {
      this.qrVisorDataUrl.set(null);
      return;
    }
    this.qrVisorGenerando.set(true);
    // Refrescamos la base configurada en /configuracion (puede haber cambiado).
    // Si falla la lectura, caemos al origin del navegador.
    try {
      const cfg = await firstValueFrom(this.api.obtenerVisorConfig());
      this.visorBaseConfig.set(cfg.baseUrl ?? '');
    } catch {
      this.visorBaseConfig.set('');
    }
    const base = this.visorBaseConfig() || window.location.origin;
    const url = `${base}/visor/${encodeURIComponent(username)}`;
    try {
      // Carga dinámica para no inflar el bundle inicial — el dialog rara vez
      // se abre y la lib pesa varios KB. `qrcode` es CommonJS: según el interop
      // de esbuild las funciones pueden quedar bajo `.default` en vez de la raíz
      // del namespace, así que normalizamos antes de usar `toDataURL`.
      const mod = await import('qrcode');
      const QRCode = ((mod as { default?: typeof import('qrcode') }).default ??
        mod) as typeof import('qrcode');
      const dataUrl = await QRCode.toDataURL(url, {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 512,
      });
      this.qrVisorDataUrl.set(dataUrl);
    } catch (err) {
      // Si el browser no logra generar (raro), mostramos la URL como texto
      // de fallback en el HTML.
      console.error('No se pudo generar el QR del visor', err);
      this.qrVisorDataUrl.set(null);
    } finally {
      this.qrVisorGenerando.set(false);
    }
  }

  /** URL completa del visor del operador — para mostrar como texto debajo del QR.
   *  Usa la base configurada en /configuracion si existe, sino el origin actual. */
  readonly visorUrl = computed(() => {
    const username = this.auth.currentUser()?.username;
    if (!username || typeof window === 'undefined') return '';
    const base = this.visorBaseConfig() || window.location.origin;
    return `${base}/visor/${encodeURIComponent(username)}`;
  });

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
    // Reset de cantidades tipeadas — corresponden a la búsqueda anterior.
    this.cantidadesResultados.set({});

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
          // Reflejar en el visor el precio con la forma efectiva del producto
          // recién escaneado (sticky si el operador ya eligió una; sino la
          // destacada del rubro). El scan ya publicó al visor el producto.
          this.publicarFormaEnVisor();
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
   *  Lo usa el botón "✕" del header de resultados. También resetea las
   *  cantidades tipeadas — si el operador vuelve a buscar otra cosa, los
   *  inputs arrancan en 1. */
  cerrarResultadosBusqueda(): void {
    this.resultadosBusqueda.set([]);
    this.cantidadesResultados.set({});
    this.focusInput();
  }

  /** Cantidades tipeadas en cada fila de resultados (por SKU). Vive aparte
   *  del array `resultadosBusqueda()` para no mutar el `CatalogoItem`
   *  recibido del backend. Se limpia al cerrar la lista. */
  readonly cantidadesResultados = signal<Record<string, number>>({});

  cantidadResultado(sku: string): number {
    return this.cantidadesResultados()[sku] ?? 1;
  }

  setCantidadResultado(sku: string, cantidad: number): void {
    if (!Number.isFinite(cantidad) || cantidad <= 0) cantidad = 1;
    this.cantidadesResultados.set({
      ...this.cantidadesResultados(),
      [sku]: Math.floor(cantidad),
    });
  }

  /** Tope de cantidad para el input de la lista de resultados. NO se topea al
   *  stock: se permite pedir más de lo disponible (el excedente queda como
   *  pendiente de reposición vía `forzar`). Cap alto solo para evitar
   *  cantidades absurdas. */
  cantidadMaximaResultado(_it: CatalogoItem): number {
    return 9999;
  }

  /** Agregar directo al carrito desde la lista de resultados — saltea la
   *  pantalla de tiles. Útil cuando el operador ya sabe qué cantidad necesita
   *  y no quiere tener que seleccionar + ver tiles + agregar. Si el producto
   *  no tiene stock se manda `forzar=true` (mismo comportamiento que
   *  `agregarAlCarrito()` después de un scan).
   *
   *  <p>La lista de resultados queda ABIERTA tras agregar — el operador puede
   *  sumar varios productos del mismo set sin volver a buscar. La cantidad
   *  del sku recién agregado se resetea para que un siguiente click no
   *  repita la cantidad anterior. */
  agregarResultadoAlCarrito(it: CatalogoItem): void {
    if (it.habilitado === false) {
      this.toast.add({
        severity: 'warn',
        summary: 'No se puede agregar',
        detail: `${it.sku}: el producto está deshabilitado.`,
      });
      return;
    }
    if (!it.pvpKtGastroSinIva || it.pvpKtGastroSinIva <= 0) {
      this.toast.add({
        severity: 'warn',
        summary: 'No se puede agregar',
        detail: `${it.sku}: no tiene precio cargado en la lista KT GASTRO.`,
      });
      return;
    }
    const cant = this.cantidadResultado(it.sku);
    // forzar=true si no hay stock O si la cantidad pedida lo supera: el backend
    // acepta el ítem (o el excedente) como pendiente de reposición.
    const forzar = it.stockTotal == null || it.stockTotal <= 0 || cant > it.stockTotal;
    this.api.agregarItemCarrito(it.sku, cant, forzar).subscribe({
      next: (res) => {
        this.carrito.set(res.carrito.items);
        // Reset de la cantidad del sku para evitar duplicar la cantidad
        // anterior si el operador vuelve a apretar "Agregar" para el mismo
        // producto sin tocar el input.
        this.cantidadesResultados.update((m) => {
          const nm = { ...m };
          delete nm[it.sku];
          return nm;
        });
        const itemToast = [{
          sku: it.sku,
          descripcion: it.descripcion ?? null,
          cantidad: res.cantidadAgregada,
        }];
        if (res.cantidadAgregada === 0) {
          this.toast.add({
            severity: 'warn',
            summary: 'Sin stock',
            detail: `${it.sku}: ${res.motivo ?? 'no se pudieron sumar unidades.'}`,
          });
        } else if (forzar) {
          this.toast.add({
            key: 'carrito-add',
            severity: 'warn',
            summary: 'Agregado sin stock',
            detail: 'Queda como pendiente de reposición.',
            data: itemToast,
            life: 4000,
          });
          this.flashItemCarrito(it.sku);
        } else {
          this.toast.add({
            key: 'carrito-add',
            severity: res.recortado ? 'warn' : 'success',
            summary: res.recortado ? 'Cantidad ajustada al stock' : 'Agregado al carrito',
            detail: res.recortado ? `Tope disponible: ${it.stockTotal}.` : undefined,
            data: itemToast,
            life: res.recortado ? 3500 : 2500,
          });
          this.flashItemCarrito(it.sku);
        }
        this.focusInput();
      },
      error: (err) => toastError(this.toast, 'Carrito', err, 'No se pudo agregar al carrito.'),
    });
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
        this.publicarFormaEnVisor();
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

  /** Un producto es vendible cuando está habilitado y tiene un precio cargado
   *  en la lista KT GASTRO. Si el precio es 0/null, lo más probable es que DUX
   *  no tenga ese item en la lista — agregarlo generaría un pedido fantasma
   *  sin total. El stock NO bloquea el agregado: si el operador quiere reservar
   *  un item sin stock disponible, el carrito lo acepta como excedido (rojo)
   *  y el operador decide si lo deja para reposición o lo quita. */
  productoVendible(r: ScanResult): boolean {
    if (r.habilitado === false) return false;
    if (r.pvpKtGastroConIva == null || r.pvpKtGastroConIva <= 0) return false;
    return true;
  }

  /** True si el producto se va a agregar "forzando" porque no tiene stock
   *  disponible. Sirve tanto para mostrar un toast informativo distinto como
   *  para flaguear el request al backend (que sino recortaría a 0). */
  private sinStockDisponible(r: ScanResult): boolean {
    return r.stockTotal != null && r.stockTotal <= 0;
  }

  agregarAlCarrito(cantidad: number = 1): void {
    const r = this.ultimoScan();
    if (!r) return;
    if (!this.productoVendible(r)) {
      const motivo = r.habilitado === false
        ? 'el producto está deshabilitado'
        : 'no tiene precio cargado en la lista KT GASTRO';
      this.toast.add({
        severity: 'warn',
        summary: 'No se puede agregar',
        detail: `${r.sku}: ${motivo}.`,
      });
      return;
    }
    const cant = cantidad <= 0 ? 1 : cantidad;
    // forzar=true si no hay stock O si la cantidad pedida lo supera: el backend
    // acepta el ítem (o el excedente) como pendiente de reposición.
    const forzar = this.sinStockDisponible(r)
      || (r.stockTotal != null && cant > r.stockTotal);
    this.api.agregarItemCarrito(r.sku, cant, forzar).subscribe({
      next: (res) => {
        // El SSE carrito-updated ya va a llegar (con el state nuevo); igual
        // tocamos `this.carrito` con el state del response para no esperar
        // al round-trip del SSE en la misma pantalla.
        this.carrito.set(res.carrito.items);
        // Item del data del toast — la descripción + sku se renderizan con
        // el template custom de `key='carrito-add'` en app.html.
        const itemToast = [{
          sku: r.sku,
          descripcion: r.descripcion ?? null,
          cantidad: res.cantidadAgregada,
        }];
        if (res.cantidadAgregada === 0) {
          // Caso especial: no se sumó nada. No mostramos el item en el toast
          // estilizado porque "×0" se vería raro — usamos el toast plano.
          this.toast.add({
            severity: 'warn',
            summary: 'Sin stock',
            detail: `${r.sku}: ${res.motivo ?? 'no se pudieron sumar unidades.'}`,
          });
        } else if (forzar) {
          // Forzado por el operador: el item se agregó aunque no haya stock.
          // Lo marcamos como warn (no success) para que el operador note que
          // queda como excedido y tendrá que resolverlo antes del pedido a DUX.
          this.toast.add({
            key: 'carrito-add',
            severity: 'warn',
            summary: 'Agregado sin stock',
            detail: 'Queda como pendiente de reposición.',
            data: itemToast,
            life: 4000,
          });
          this.flashItemCarrito(r.sku);
        } else {
          this.toast.add({
            key: 'carrito-add',
            severity: res.recortado ? 'warn' : 'success',
            summary: res.recortado ? 'Cantidad ajustada al stock' : 'Agregado al carrito',
            detail: res.recortado
              ? `Tope disponible: ${r.stockTotal}.`
              : undefined,
            data: itemToast,
            life: res.recortado ? 3500 : 2500,
          });
          this.flashItemCarrito(r.sku);
        }
        this.focusInput();
      },
      error: (err) => toastError(this.toast, 'Carrito', err, 'No se pudo agregar al carrito.'),
    });
  }

  /** Feedback visual del scan: pulso verde KT sobre el item agregado al carrito.
   *  Usa Web Animations API (no signals) — así re-scanear el mismo SKU re-dispara
   *  la animación en cada llamada sin pelearse con change detection. */
  private flashItemCarrito(sku: string): void {
    // setTimeout 0 → esperamos al ciclo de render para que el <li> exista en
    // DOM si es la primera vez que se agrega el sku.
    setTimeout(() => {
      const el = document.querySelector<HTMLElement>(`[data-sku="${CSS.escape(sku)}"]`);
      if (!el) return;
      el.animate(
        [
          { backgroundColor: 'rgba(126, 186, 0, 0.35)' },
          { backgroundColor: 'rgba(126, 186, 0, 0.18)', offset: 0.6 },
          { backgroundColor: 'transparent' },
        ],
        { duration: 700, easing: 'ease-out' },
      );
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 0);
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

  /** Notifica al operador cuando un add proviene del visor (cliente en su celular):
   *  toast informativo + mismo pulso verde sobre la fila que ya hace el flujo
   *  local. Compara estado previo vs nuevo para decidir qué SKUs cambiaron.
   *
   *  <p>El toast usa el {@code key='cliente-carrito'} que tiene un template
   *  custom en {@code app.html} — los datos del producto van en
   *  {@code message.data} (sku + descripcion + cantidad agregada) para que
   *  el operador vea de un vistazo QUÉ pidió el cliente, no solo el SKU. */
  private procesarCambioDesdeVisor(previo: CarritoItem[], nuevo: CarritoItem[]): void {
    // Indexamos por itemKey (no sku) porque varios items genéricos comparten
    // el SKU comodín. Si indexáramos por sku, el último generic ganaría el
    // slot del Map y los diffs del resto saldrían contra una cantidad
    // incorrecta — falsos positivos del tipo "el cliente sumó N unidades".
    // El visor solo puede agregar items normales (backend rechaza el SKU
    // comodín), pero el carrito puede tener genéricos preexistentes.
    const prevMap = new Map(previo.map((it) => [it.itemKey, it]));
    const items: { sku: string; descripcion: string | null; cantidad: number }[] = [];
    const skusAgregados: string[] = [];
    for (const it of nuevo) {
      const antes = prevMap.get(it.itemKey);
      const cantidadAntes = antes?.cantidad ?? 0;
      const diff = it.cantidad - cantidadAntes;
      if (diff > 0) {
        items.push({
          sku: it.sku,
          descripcion: it.descripcion ?? antes?.descripcion ?? null,
          cantidad: diff,
        });
        skusAgregados.push(it.sku);
      }
    }
    if (items.length === 0) return;
    this.toast.add({
      key: 'carrito-add',
      severity: 'success',
      summary: items.length === 1
        ? 'El cliente sumó un producto'
        : `El cliente sumó ${items.length} productos`,
      // No mandamos `detail`: la lista de productos con su descripción ya se
      // renderiza vía `data` en el template custom. Un detail redundante con
      // "SKU ×N" se mostraría debajo y duplicaría la info.
      data: items,
      life: 6000,
    });
    // Sin la animación el operador veía el toast pero podía perderse cuál fila
    // del carrito cambió — sobre todo si la lista es larga y el item ya estaba.
    for (const sku of skusAgregados) {
      this.flashItemCarrito(sku);
    }
  }

  /** {@code itemKey} es la clave única dentro del carrito (SKU para items
   *  normales, uid sintético para genéricos). El template del carrito ya
   *  pasa `it.itemKey` desde cada fila. */
  actualizarCantidad(itemKey: string, cantidad: number): void {
    // Mínimo 1 — para eliminar el item está la X dedicada al lado.
    const c = Math.max(1, cantidad ?? 1);
    // Update local optimista: la UI (cant. total, subtotal, etc.) responde
    // instantáneo aunque el PATCH al backend se debouncee 250ms.
    this.carrito.set(
      this.carrito().map((it) => (it.itemKey === itemKey ? { ...it, cantidad: c } : it)),
    );
    this.cantidadUpdates$.next({ itemKey, cantidad: c });
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
    const localByKey = new Map(this.carrito().map((it) => [it.itemKey, it]));
    return remoteItems.map((remote) => {
      const local = localByKey.get(remote.itemKey);
      if (local && local.cantidad !== remote.cantidad) {
        return { ...remote, cantidad: local.cantidad };
      }
      return remote;
    });
  }

  // ============================================================
   // Producto genérico (carrito) — alta a mano de una línea con el SKU
   // comodín de DUX. A diferencia del scan normal, no consulta catálogo y
   // cada confirmación crea una línea NUEVA en el carrito (no se mergea con
   // otras genéricas aunque compartan SKU). El backend genera el itemKey y
   // lo devuelve en el state del carrito.
  // ============================================================
  abrirGenerico(): void {
    if (!this.skuGenerico()) {
      this.toast.add({
        severity: 'warn',
        summary: 'No disponible',
        detail: 'El SKU comodín no está configurado en el backend.',
        life: 4000,
      });
      return;
    }
    this.mostrarDialogGenerico.set(true);
  }

  onAgregarGenerico(data: ProductoGenericoData): void {
    this.procesandoGenerico.set(true);
    this.api.agregarGenericoCarrito({
      descripcion: data.descripcion,
      precioConIva: data.precioConIva,
      porcIva: data.porcIva,
      cantidad: data.cantidad,
      maquinaria: data.maquinaria,
    }).subscribe({
      next: (state) => {
        this.procesandoGenerico.set(false);
        this.mostrarDialogGenerico.set(false);
        this.carrito.set(state.items);
        this.toast.add({
          severity: 'success',
          summary: 'Producto genérico agregado',
          detail: `${data.descripcion}${data.cantidad > 1 ? ` (${data.cantidad}u)` : ''}`,
          life: 3000,
        });
        this.focusInput();
      },
      error: (err) => {
        this.procesandoGenerico.set(false);
        toastError(this.toast, 'Producto genérico', err, 'No se pudo agregar.');
      },
    });
  }

  eliminarDelCarrito(itemKey: string): void {
    this.api.eliminarItemCarrito(itemKey).subscribe({
      next: (state) => {
        this.carrito.set(state.items);
        // Limpiamos el descuento manual del ítem que se fue para no dejar
        // entradas huérfanas en el mapa.
        if (this.descuentoManual(itemKey) > 0) this.setDescuentoManual(itemKey, 0);
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
    // Reset de los descuentos manuales (estado local) — el próximo cliente
    // arranca sin descuentos cargados a mano.
    this.descuentosManuales.set({});
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

  /** Sugerencias del autocomplete del email — delega en
   *  {@link calcularSugerenciasEmail} (helper compartido por todas las
   *  pantallas con autocomplete de email del cliente). */
  onCompletarEmail(event: AutoCompleteCompleteEvent): void {
    this.sugerenciasEmail.set(calcularSugerenciasEmail(event.query));
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
    // Indexamos por itemKey, no por sku, para que múltiples genéricos
    // (todos con el SKU comodín) no colapsen al mismo entry del Map.
    const cantidadesPedidas = new Map(this.carrito().map((it) => [it.itemKey, it.cantidad]));
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
          const pedida = cantidadesPedidas.get(it.itemKey) ?? it.cantidad;
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

  /** Botón "Enviar igual" del dialog de stock insuficiente — el operador eligió
   *  mandar el pedido a DUX aunque haya items con cantidad > stock disponible.
   *  Cierra el dialog y dispara el envío sin re-validar contra DUX. */
  enviarIgualConExcedidos(): void {
    this.mostrarDialogExcedidos.set(false);
    this.enviarPedido();
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
        // "Nombre y apellido" del cliente real → DUX `nombre`. Obligatorio
        // desde mayo 2026 (validado por el dialog antes de llegar acá).
        nombre: c.nombre.trim(),
        categoriaFiscal: this.categoriaFiscalFinal,
        tipoDoc: 'CUIT',
        nroDoc: c.nroDoc ?? undefined,
        telefono: c.telefono.trim(),
        email: c.email.trim(),
        // Rubro: si eligió una opción predefinida va esa; si eligió "otros"
        // mandamos el texto libre. El dialog garantiza que uno u otro tenga
        // valor antes de llegar acá.
        rubro: this.rubroFinal(),
        domicilio: c.domicilio.trim() || undefined,
        codigoProvincia: c.codigoProvincia ?? undefined,
        idLocalidad: c.idLocalidad ?? undefined,
        observaciones: c.observaciones.trim() || undefined,
        // Forma de pago elegida en el carrito (null si "Efectivo" / sin
        // selección). El backend aplica el recargo % a cada precioUnitario
        // antes de mandar a DUX.
        formaPagoId: this.formaPagoSeleccionada()?.id ?? undefined,
        items: this.carrito().map((it) => {
          // Descuento per-item EFECTIVO: si el ítem tiene descuento MANUAL (>0)
          // se manda ese (reemplaza la escala para esa línea); sino el de escala
          // para los elegibles. Los ítems excluidos por rubro (MAQUINAS
          // INDUSTRIALES) sin manual NO reciben el descuento por escala —
          // mandamos `undefined` para que DUX los facture al PVP de lista.
          // Los genéricos marcados como "maquinaria" caen acá automáticamente
          // porque el backend les setea ese mismo rubro al crearlos.
          const descItem = this.descuentoParaItem(it);
          return {
            sku: it.sku,
            cantidad: it.cantidad,
            // Rubro del ítem: el backend lo usa para resolver el perfil
            // (Normal/Maquinaria) de la forma de pago. Imprescindible para
            // genéricos, cuyo rubro real no está en el cache del comodín.
            rubro: it.rubro ?? undefined,
            // Mandamos el precio CON IVA: la lista "KT GASTRO" en DUX está configurada
            // como "incluye IVA", entonces DUX espera valores con-IVA y descuenta el IVA
            // internamente. Si mandamos sin-IVA, DUX lo trata como con-IVA y queda mal.
            // El display en el showroom sigue mostrando sin-IVA al operador (informativo).
            precioUnitario: it.pvpKtGastroConIva,
            descuentoPorcentaje: descItem > 0 ? descItem : undefined,
            // Genéricos: el operador eligió el IVA en el dialog (21 o 10.5).
            // Sin esto, el backend caería al porcIva del cache del SKU comodín
            // que no representa al producto real.
            porcIva: it.generico ? (it.porcIva ?? undefined) : undefined,
            // Comentarios: descripción tipeada por el operador, viaja al
            // campo `comentarios` de la línea en el payload DUX.
            comentarios: it.comentarios ?? undefined,
          };
        }),
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
