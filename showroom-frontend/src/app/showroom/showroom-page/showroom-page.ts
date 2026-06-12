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
  untracked,
  viewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { EMPTY, Subject, firstValueFrom } from 'rxjs';
import { catchError, debounceTime, groupBy, mergeMap, switchMap, tap } from 'rxjs/operators';
import { ConfirmationService, MessageService } from 'primeng/api';
import { AvatarModule } from 'primeng/avatar';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { CheckboxModule } from 'primeng/checkbox';
import { DialogModule } from 'primeng/dialog';
import { OverlayBadgeModule } from 'primeng/overlaybadge';
import { IconFieldModule } from 'primeng/iconfield';
import { ImageModule } from 'primeng/image';
import { InputIconModule } from 'primeng/inputicon';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { MeterGroupModule } from 'primeng/metergroup';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { SelectModule } from 'primeng/select';
import { SplitterModule } from 'primeng/splitter';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import { AuthService } from '../../auth/auth.service';
import { BackendStatusService } from '../backend-status.service';
import { CarritoItem, CatalogoItem, EscalaDescuento, FormaPago, ScanResult } from '../models';
import {
  hayEscalonSuperior,
  iconoFormaReferencia,
  ordenarEscalasPorUmbral,
} from '../precio-referencia.util';
import { PrecioPerfilService } from '../precio-perfil.service';
import { SesionClienteService } from '../sesion-cliente.service';
import { ShowroomService } from '../showroom.service';
import { construirVisorUrl, generarQrDataUrl } from '../visor-qr.util';
import { toastError } from '../toast.utils';
import {
  ProductoGenericoData,
  ProductoGenericoDialog,
} from '../producto-generico-dialog/producto-generico-dialog';
import { PageHeader } from '../page-header/page-header';
import { QrCelularDialog } from '../qr-celular-dialog/qr-celular-dialog';
import { SyncButton } from '../sync-button/sync-button';
import {
  CrearPedidoDialog,
  PedidoClientePrefill,
  PedidoItemEntrada,
} from '../crear-pedido-dialog/crear-pedido-dialog';


@Component({
  selector: 'app-showroom-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    FormsModule,
    AvatarModule,
    ButtonModule,
    CardModule,
    CheckboxModule,
    DialogModule,
    IconFieldModule,
    ImageModule,
    InputIconModule,
    InputNumberModule,
    InputTextModule,
    MeterGroupModule,
    OverlayBadgeModule,
    ProgressSpinnerModule,
    SelectModule,
    SplitterModule,
    TagModule,
    TooltipModule,
    ProductoGenericoDialog,
    PageHeader,
    QrCelularDialog,
    SyncButton,
    CrearPedidoDialog,
  ],
  templateUrl: './showroom-page.html',
  styleUrl: './showroom-page.scss',
})
export class ShowroomPage implements AfterViewInit {
  private readonly api = inject(ShowroomService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(MessageService);
  private readonly confirmationService = inject(ConfirmationService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly backendStatus = inject(BackendStatusService);
  private readonly precioPerfil = inject(PrecioPerfilService);
  private readonly sesionService = inject(SesionClienteService);

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

  /** Orden elegido para los resultados de búsqueda. 'relevancia' = ranking del
   *  backend (default). El resto fuerza el orden en el backend sobre TODO el
   *  resultado (no solo la página visible). */
  readonly ordenResultados = signal<'relevancia' | 'producto' | 'precio_asc' | 'precio_desc'>('relevancia');

  /** Opciones del selector de orden de resultados (para el template). */
  readonly opcionesOrdenResultados: { label: string; value: 'relevancia' | 'producto' | 'precio_asc' | 'precio_desc' }[] = [
    { label: 'Relevancia', value: 'relevancia' },
    { label: 'Producto A-Z', value: 'producto' },
    { label: 'Precio: menor a mayor', value: 'precio_asc' },
    { label: 'Precio: mayor a menor', value: 'precio_desc' },
  ];

  /** Filtro por proveedor de los resultados de búsqueda. null = todos. Se
   *  aplica en el backend sobre todo el resultado, igual que el orden. */
  readonly proveedorFiltro = signal<string | null>(null);

  /** Proveedores disponibles para el dropdown del filtro (cargados del backend). */
  readonly proveedoresDisponibles = signal<string[]>([]);

  /** True mientras se re-busca por un cambio de orden. Muestra un spinner chico
   *  junto al selector SIN tapar la lista (a diferencia de `cargandoScan`, que
   *  reemplaza toda el área de resultados). */
  readonly reordenando = signal(false);

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

  /** Orden de visualización del carrito. {@code null} = orden de escaneo (como
   *  llega del backend). Solo afecta cómo se muestra: el payload del pedido
   *  sigue usando {@link carrito} en su orden original. */
  readonly ordenCarrito = signal<{ campo: 'producto' | 'precio'; dir: 'asc' | 'desc' } | null>(null);

  /** Carrito ordenado para el render. Copia ordenada por descripción (producto)
   *  o por el precio unitario mostrado (con la forma elegida). */
  readonly carritoOrdenado = computed<CarritoItem[]>(() => {
    const items = this.carrito();
    const orden = this.ordenCarrito();
    if (!orden) return items;
    const factor = orden.dir === 'asc' ? 1 : -1;
    if (orden.campo === 'producto') {
      return [...items].sort((a, b) =>
        (a.descripcion ?? '').localeCompare(b.descripcion ?? '', 'es', { sensitivity: 'base' }) * factor);
    }
    // Orden por precio: pre-calcular el precio de cada ítem UNA vez
    // (decorate-sort-undecorate) en vez de reevaluar `precioItemForma` en cada
    // comparación del sort (O(n log n) llamadas → O(n)).
    return items
      .map((it) => ({ it, precio: this.precioItemForma(it) }))
      .sort((a, b) => (a.precio - b.precio) * factor)
      .map((x) => x.it);
  });

  /** Cicla el orden del carrito para un campo: asc → desc → sin orden (escaneo). */
  ordenarCarritoPor(campo: 'producto' | 'precio'): void {
    const actual = this.ordenCarrito();
    if (!actual || actual.campo !== campo) {
      this.ordenCarrito.set({ campo, dir: 'asc' });
    } else if (actual.dir === 'asc') {
      this.ordenCarrito.set({ campo, dir: 'desc' });
    } else {
      this.ordenCarrito.set(null);
    }
  }

  /** Ícono del botón de orden de un campo: flecha según dirección, o neutro. */
  iconoOrdenCarrito(campo: 'producto' | 'precio'): string {
    const o = this.ordenCarrito();
    if (!o || o.campo !== campo) return 'pi pi-sort-alt';
    return o.dir === 'asc' ? 'pi pi-sort-amount-up-alt' : 'pi pi-sort-amount-down';
  }

  /** Sesión de atención — el estado lo centraliza {@link SesionClienteService}
   *  (global por operador, sincronizado por SSE), compartido con el
   *  presupuestador. */
  readonly sesionActiva = this.sesionService.sesion;
  readonly haySesionActiva = this.sesionService.haySesionActiva;
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
  /** Visibilidad del modal unificado de pedido (app-crear-pedido-dialog) en el
   *  showroom. Reemplaza al formulario de cliente que vivía inline acá. */
  readonly mostrarCrearPedidoShowroom = signal(false);
  /** Ítems del carrito mapeados al formato que consume el modal de pedido —
   *  mismo armado que usaba el envío directo (precio c/IVA, descuento efectivo
   *  por ítem, IVA de genéricos), para no cambiar lo que se factura en DUX. */
  readonly itemsPedidoShowroom = computed<PedidoItemEntrada[]>(() =>
    this.carrito().map((it) => {
      const d = this.descuentoParaItem(it);
      return {
        sku: it.sku,
        cantidad: it.cantidad,
        precioConIva: it.pvpKtGastroConIva,
        porcIva: it.generico ? (it.porcIva ?? null) : null,
        descuentoPorcentaje: d > 0 ? d : null,
        rubro: it.rubro ?? null,
        comentarios: it.comentarios ?? null,
      };
    }),
  );
  /** Pre-llenado del modal: nombre de la sesión de atención + forma de pago
   *  elegida en el carrito. El resto de los datos los completa el operador. */
  readonly prefillPedidoShowroom = computed<PedidoClientePrefill>(() => ({
    nombre: this.haySesionActiva() ? (this.sesionActiva().nombre ?? null) : null,
    formaPagoId: this.formaPagoSeleccionada()?.id ?? null,
  }));

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

  readonly screenLg = signal(
    typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches,
  );

  // La navegación vive ahora en <app-main-menu /> (p-menubar reusable dentro
  // de app-top-actions) — sin esto se duplicaba la lista en cada toolbar.


  /**
   * Escalones de descuento configurados (umbral subtotal s/IVA → % a aplicar).
   * Se cargan en el constructor desde el backend; mientras llegan se asume
   * lista vacía (sin descuento), lo cual es el default seguro.
   */
  readonly escalasDescuento = signal<EscalaDescuento[]>([]);

  /** Formas de pago activas (cargadas al iniciar). El operador elige una en
   *  el dropdown del carrito; el recargo % se aplica al total. */
  readonly formasPagoActivas = this.precioPerfil.formasPago;

  /** Forma de pago seleccionada por el operador. Null = sin financiación
   *  (precio base, equivalente a "Efectivo 1 cuota / 0%"). */
  readonly formaPagoSeleccionada = signal<FormaPago | null>(null);


  /** Forma destacada/default para el perfil del producto: de las formas activas
   *  marcadas como referencia de ese perfil (menaje → `precioReferencia`;
   *  maquinaria → `precioReferenciaMaquinaria`), la de menor `orden`. Null si
   *  ninguna marcada (entonces se cae al precio de lista según rubro). Mismo
   *  criterio que el presupuestador. */
  formaDestacada(esMaquinaria: boolean): FormaPago | null {
    return this.precioPerfil.formaDestacada(esMaquinaria);
  }

  /** Forma EFECTIVA del scan = la forma de pago seleccionada (MISMO estado que
   *  usa el carrito: el selector "Mostrar precio en" y el del carrito comparten
   *  `formaPagoSeleccionada`), o la destacada del perfil del producto escaneado
   *  si todavía no hay ninguna seleccionada. */
  readonly formaScanEfectiva = computed<FormaPago | null>(() => {
    const elegida = this.formaPagoSeleccionada();
    if (elegida) return elegida;
    return this.formaDestacada(this.rubroCotizaSinIva(this.ultimoScan()?.rubro));
  });

  /** True si el rubro cotiza sin IVA (su precio base es el PVP sin IVA). */
  rubroCotizaSinIva(rubro: string | null | undefined): boolean {
    return this.precioPerfil.rubroCotizaSinIva(rubro);
  }

  /** Escalones ordenados de mayor a menor umbral — útil para resolver el escalón vigente. */
  private readonly escalasDesc = computed(() =>
    [...this.escalasDescuento()].sort((a, b) => b.umbralMin - a.umbralMin),
  );

  /** Escalones ordenados de menor a mayor umbral — orden natural para mostrar
   *  los tiles "comprá más" (el más cercano primero, los mejores al final). */
  readonly escalasOrdenadas = computed(() =>
    ordenarEscalasPorUmbral(this.escalasDescuento()),
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

  /** Subtotal contando SOLO los ítems elegibles para el descuento por escala,
   *  valuados con la FORMA DE REFERENCIA (la marcada "Precio ref." — Efectivo,
   *  `formaDestacada(false)`). Es la base sobre la que se COMPARA el umbral.
   *  Los ítems excluidos (ej. MAQUINAS INDUSTRIALES) no empujan el escalón ni
   *  reciben el descuento. Fallback al PVP s/IVA si no hay forma ref. marcada. */
  readonly subtotalElegibleDescuento = computed(() => {
    const formaRef = this.formaDestacada(false);
    return this.carrito()
      .filter((it) => !this.excluidoDescuentoEscala(it))
      .reduce((acc, it) => {
        const precio = formaRef
          ? this.precioReferenciaPorForma(it, formaRef)
          : (it.pvpKtGastroSinIva ?? 0);
        return acc + precio * it.cantidad;
      }, 0);
  });

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
   * input lo muestra como reflejo del % EFECTIVO ({@link descuentoEfectivoPctForma}):
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

  /** Subtotal del carrito a la FORMA DE PAGO elegida = suma de los subtotales de
   *  cada fila (precio con la forma × cantidad). Lleva o no IVA por ítem según el
   *  perfil de su rubro y la forma — coincide con lo que muestra cada línea. Sin
   *  descuento. */
  readonly subtotalCarrito = computed(() =>
    this.carrito().reduce((acc, it) => acc + this.subtotal(it), 0),
  );

  /** Monto de descuento (en pesos) sobre el subtotal a la forma elegida —
   *  descuento EFECTIVO por ítem aplicado al precio con la forma. */
  readonly descuentoMontoForma = computed(() =>
    this.carrito().reduce(
      (acc, it) => acc + this.subtotal(it) * (this.descuentoParaItem(it) / 100),
      0,
    ),
  );

  /** % efectivo de descuento sobre el subtotal a la forma elegida. */
  readonly descuentoEfectivoPctForma = computed(() => {
    const sub = this.subtotalCarrito();
    if (sub <= 0) return 0;
    return (this.descuentoMontoForma() / sub) * 100;
  });

  /** Total a cobrar = subtotal a la forma − descuento. Es lo que paga el cliente
   *  (Σ precio con la forma × (1−desc) por ítem); coincide con la suma de filas. */
  readonly totalACobrar = computed(
    () => this.subtotalCarrito() - this.descuentoMontoForma(),
  );

  /** True si en el carrito hay AL MENOS un ítem con descuento manual cargado. */
  readonly hayDescuentoManual = computed(() =>
    this.carrito().some((it) => this.descuentoManual(it.itemKey) > 0),
  );

  /** Total del carrito por forma de pago, calculado UNA sola vez por cambio
   *  (carrito / formas / precios). Antes {@link totalParaForma} recorría todo el
   *  carrito en cada llamada, y el dialog comparativo lo invoca por fila + lo
   *  usa {@link formaMasBarata} → O(formas × ítems) recalculado en cada change
   *  detection. Memoizado como `Map<formaId, total>` se calcula una vez y se
   *  lee O(1). Descuento per-item para que los rubros excluidos (MAQUINAS
   *  INDUSTRIALES) no reciban la rebaja por escala. */
  private readonly totalesPorForma = computed<Map<number, number>>(() => {
    const carrito = this.carrito();
    const mapa = new Map<number, number>();
    for (const fp of this.formasPagoActivas()) {
      let total = 0;
      for (const it of carrito) {
        const descuento = this.descuentoParaItem(it);
        total += this.precioReferenciaPorForma(it, fp) * (1 - descuento / 100) * it.cantidad;
      }
      mapa.set(fp.id, total);
    }
    return mapa;
  });

  /** Total final del carrito para una forma de pago dada — usado en el dialog
   *  "comparativa de formas de pago" que el operador le muestra al cliente.
   *  Lee del mapa memoizado {@link totalesPorForma}. */
  totalParaForma(fp: FormaPago): number {
    return this.totalesPorForma().get(fp.id) ?? 0;
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

  /** Forma de pago con el menor total — para el badge "MEJOR PRECIO". Deriva del
   *  mapa memoizado en vez de recorrer el carrito por cada forma. */
  readonly formaMasBarata = computed(() => {
    const formas = this.formasPagoActivas();
    if (formas.length === 0) return null;
    const totales = this.totalesPorForma();
    let min = formas[0];
    let minTotal = totales.get(min.id) ?? Infinity;
    for (const fp of formas.slice(1)) {
      const t = totales.get(fp.id) ?? Infinity;
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
    // Sobre la lista ordenada por umbral asc — no confiar en el orden de la signal
    // cruda (el "más cercano" depende de que estén ordenados de menor a mayor).
    return this.escalasOrdenadas().find((e) => sub < e.umbralMin) ?? null;
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
    return this.precioPerfil.perfilForma(forma, esMaquinaria);
  }

  /** Precio de referencia de un producto (scan o ítem de carrito) para una forma
   *  de pago dada. Siempre parte del PVP con IVA; el perfil (Normal/Maquinaria)
   *  del rubro decide el recargo y si lleva IVA. */
  precioReferenciaPorForma(
    r: { pvpKtGastroConIva: number | null; pvpKtGastroSinIva: number | null; porcIva: number | null; rubro?: string | null },
    forma: FormaPago,
  ): number {
    return this.precioPerfil.precioReferenciaPorForma(r, forma);
  }

  /** Precio unitario de un ítem del carrito según la forma elegida (o la primaria
   *  si no hay forma seleccionada) y el rubro. */
  precioItemForma(it: CarritoItem): number {
    const fp = this.formaPagoSeleccionada();
    return fp ? this.precioReferenciaPorForma(it, fp) : this.precioReferenciaPrimario(it);
  }

  /** Precio de REFERENCIA de un producto (scan o ítem) según el rubro: el de la
   *  forma destacada de su perfil; si no hay marcada, precio de lista por rubro.
   *  Delega en el servicio compartido. Usado como base de los escalones cuando
   *  todavía no hay una forma elegida en el carrito. */
  precioReferenciaPrimario(
    r: { pvpKtGastroConIva: number | null; porcIva: number | null; pvpKtGastroSinIva: number | null; rubro?: string | null },
  ): number {
    return this.precioPerfil.precioReferencia(r);
  }

  /** true si hay un escalón con umbral mayor (mejor descuento) que el precio
   *  ya alcanza. Usado para atenuar tiles "menores" cuando otro mejor aplica. */
  haySuperior(precio: number, escala: EscalaDescuento): boolean {
    return hayEscalonSuperior(precio, escala, this.escalasOrdenadas());
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

    // Formas de pago activas + rubros que cotizan sin IVA. Los rubros definen
    // qué productos usan el PVP sin IVA como precio base (si falla, todos
    // cotizan con IVA). Las formas alimentan el selector del carrito.
    this.precioPerfil.cargar();

    // Proveedores para el dropdown del filtro de búsqueda.
    this.cargarProveedores();

    // La primera forma de la lista (orden asc) queda seleccionada por default —
    // el operador la configuró como "default" desde /configuracion (p.ej.
    // Efectivo). Lo hacemos en un effect que reacciona a la carga async de
    // formas, preservando la guarda "solo si todavía no hay una elegida".
    effect(() => {
      const lista = this.precioPerfil.formasPago();
      if (lista.length > 0 && untracked(() => this.formaPagoSeleccionada()) == null) {
        this.formaPagoSeleccionada.set(lista[0]);
      }
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
    // El estado de sesión lo centraliza SesionClienteService (hidratación + SSE
    // en vivo, compartido con el presupuestador). Acá solo hidratamos al cargar
    // para decidir la UX: si no hay sesión activa, abrimos el modal de "Nuevo
    // cliente" para que el operador identifique al cliente antes de escanear.
    this.sesionService.hidratar()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (s) => { if (s.id == null) this.abrirDialogoNuevoCliente(); },
        error: (err) => console.warn('[sesion] no se pudo hidratar:', err),
      });

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
        this.mostrarCrearPedidoShowroom() ||
        this.mostrarDialogVisor() ||
        this.mostrarDialogReview() ||
        this.mostrarDialogGenerico();
      if (dialogAbiertoPrevio && !algunoAbierto) {
        this.focusInput();
      }
      dialogAbiertoPrevio = algunoAbierto;
    });

    const refocus = (e: MouseEvent) => {
      if (this.mostrarCrearPedidoShowroom()) return;
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
    if (e.key === '/' && !this.mostrarCrearPedidoShowroom()) {
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
    this.publicarFormaEnVisor();
    this.focusInput();
  }

  /** El operador eligió una forma en el selector del scan. Queda sticky y se
   *  refleja en el visor del cliente. Devuelve el foco al input para seguir
   *  escaneando. */
  onCambiarFormaScan(fp: FormaPago | null): void {
    this.formaPagoSeleccionada.set(fp);
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
    this.qrVisorDataUrl.set(await generarQrDataUrl(this.visorUrl()));
    this.qrVisorGenerando.set(false);
  }

  /** URL completa del visor del operador — para mostrar como texto debajo del QR.
   *  Usa la base configurada en /configuracion si existe, sino el origin actual. */
  readonly visorUrl = computed(() => {
    const username = this.auth.currentUser()?.username;
    if (!username) return '';
    return construirVisorUrl(this.visorBaseConfig(), username, 'visor');
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
    // Cada búsqueda NUEVA arranca sin el filtro de proveedor de la búsqueda
    // anterior (sino quedaba "pegado" y filtraba sin que el operador lo note).
    // Los re-search por cambio de filtro/orden NO pasan por acá, así que se
    // preservan correctamente.
    this.proveedorFiltro.set(null);
    // El dropdown de proveedores se acota a lo buscado: solo los proveedores de
    // los productos que matchean esta query.
    this.cargarProveedores(query);

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
  /** Traduce el orden elegido por el operador a los params del backend.
   *  'relevancia' → sin params (el backend usa su ranking). */
  private ordenResultadosParams(): { sortField?: 'descripcion' | 'precio'; sortOrder?: 'asc' | 'desc' } {
    switch (this.ordenResultados()) {
      case 'producto': return { sortField: 'descripcion', sortOrder: 'asc' };
      case 'precio_asc': return { sortField: 'precio', sortOrder: 'asc' };
      case 'precio_desc': return { sortField: 'precio', sortOrder: 'desc' };
      default: return {};
    }
  }

  /** Cambia el orden de los resultados y re-ejecuta la búsqueda desde la
   *  primera página (el orden se aplica en el backend sobre todo el resultado). */
  cambiarOrdenResultados(orden: 'relevancia' | 'producto' | 'precio_asc' | 'precio_desc'): void {
    if (this.ordenResultados() === orden) return;
    this.ordenResultados.set(orden);
    const query = this.busquedaQuery();
    if (query) {
      this.reordenando.set(true);
      // Refinamiento de la lista: nunca auto-cargar aunque quede 1 resultado.
      this.buscarPorDescripcion(query, false);
    }
  }

  /** Cambia el filtro por proveedor y re-ejecuta la búsqueda desde la primera
   *  página (el filtro se aplica en el backend sobre todo el resultado). */
  cambiarProveedorFiltro(proveedor: string | null): void {
    if (this.proveedorFiltro() === proveedor) return;
    this.proveedorFiltro.set(proveedor);
    const query = this.busquedaQuery();
    if (query) {
      this.reordenando.set(true);
      // Refinamiento de la lista: nunca auto-cargar aunque quede 1 resultado.
      this.buscarPorDescripcion(query, false);
    }
  }

  /** Carga la lista de proveedores para el dropdown del filtro (best-effort).
   *  Si se pasa `q`, trae solo los proveedores de los productos que matchean esa
   *  búsqueda — así el filtro muestra proveedores relevantes a lo buscado. */
  private cargarProveedores(q?: string): void {
    this.api.listarProveedoresCatalogo(q)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (lista) => this.proveedoresDisponibles.set(lista),
        error: () => { /* sin proveedores el filtro queda vacío, no bloquea */ },
      });
  }

  private buscarPorDescripcion(query: string, autoAgregarSiUnico = true): void {
    const seq = ++this.scanSeq;
    this.busquedaQuery.set(query);
    this.paginaResultados.set(0);
    const { sortField, sortOrder } = this.ordenResultadosParams();
    this.api.buscarCatalogo(query, 0, this.BUSQUEDA_PAGE_SIZE, sortField, sortOrder, this.proveedorFiltro()).subscribe({
      next: (page) => {
        if (seq !== this.scanSeq) return;
        this.cargandoScan.set(false);
        this.reordenando.set(false);
        if (page.items.length === 0) {
          this.toast.add({
            severity: 'warn',
            summary: 'Sin resultados',
            detail: `No encontré nada que coincida con "${query}".`,
          });
          this.ultimoScan.set(null);
          this.resultadosBusqueda.set([]);
          this.totalResultadosBusqueda.set(0);
        } else if (autoAgregarSiUnico && page.items.length === 1 && page.total === 1) {
          // Único resultado en TODO el catálogo (no solo en la primera página)
          // — lo cargamos directo, ahorrando un click. Solo en la búsqueda
          // inicial; al refinar filtro/orden NO auto-cargamos (sino el cambio
          // de filtro escaneaba el producto al carrito sin que el operador lo
          // pidiera).
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
        this.reordenando.set(false);
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
    const { sortField, sortOrder } = this.ordenResultadosParams();
    this.api.buscarCatalogo(this.busquedaQuery(), nextPage, this.BUSQUEDA_PAGE_SIZE, sortField, sortOrder, this.proveedorFiltro()).subscribe({
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

  /** Abre el modal unificado de pedido. Si está activada la verificación de
   *  stock, la corre ANTES como paso previo (gate): refresca contra DUX y, si
   *  hay ítems excedidos, muestra el diálogo de stock; si todo alcanza (o la
   *  verificación está desactivada), abre el modal de creación de pedido. */
  abrirConfirmacion(): void {
    if (this.carrito().length === 0) return;
    if (!this.verificarStockAlEnviar()) {
      this.mostrarCrearPedidoShowroom.set(true);
      return;
    }
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
          this.excedidosStock.set(excedidos);
          this.mostrarDialogExcedidos.set(true);
          return;
        }
        this.mostrarCrearPedidoShowroom.set(true);
      },
      error: (err) => {
        this.refrescando.set(false);
        this.toast.add({
          severity: 'warn',
          summary: 'No se pudo verificar stock',
          detail: 'Abriendo el pedido igual; DUX validará al recibirlo.',
          life: 4000,
        });
        console.warn('[abrirConfirmacion] refresh failed:', err);
        this.mostrarCrearPedidoShowroom.set(true);
      },
    });
  }

  /** El modal creó el pedido en DUX OK (y el backend consumió la sesión de
   *  atención por ser origen showroom). Limpiamos el carrito, reseteamos la
   *  forma de pago al default y mostramos el diálogo de reseña en Google. */
  onPedidoShowroomCreado(): void {
    this.vaciarCarrito();
    const formas = this.formasPagoActivas();
    this.formaPagoSeleccionada.set(formas.length > 0 ? formas[0] : null);
    this.mostrarDialogReview.set(true);
  }

  // =====================================================
  // Sesión de atención al cliente
  // =====================================================

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
    this.sesionService.iniciar(nombre).subscribe({
      next: () => {
        this.iniciandoSesion.set(false);
        this.mostrarDialogoNuevoCliente.set(false);
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
    this.sesionService.cancelar().subscribe({
      next: () => {
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

  scrollAlInicio(): void {
    if (typeof window !== 'undefined') {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    this.focusInput();
  }

  /** Botón "Enviar igual" del dialog de stock insuficiente — el operador eligió
   *  mandar el pedido a DUX aunque haya items con cantidad > stock disponible.
   *  Cierra el dialog y dispara el envío sin re-validar contra DUX. */
  enviarIgualConExcedidos(): void {
    this.mostrarDialogExcedidos.set(false);
    this.mostrarCrearPedidoShowroom.set(true);
  }

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
