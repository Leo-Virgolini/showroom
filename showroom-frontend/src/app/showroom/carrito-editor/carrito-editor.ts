import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  model,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MessageService } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { IconFieldModule } from 'primeng/iconfield';
import { ImageModule } from 'primeng/image';
import { InputIconModule } from 'primeng/inputicon';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { SelectModule } from 'primeng/select';
import { TableModule } from 'primeng/table';
import { TooltipModule } from 'primeng/tooltip';
import { CambioPrecio, CatalogoItem, FormaPago, PresupuestoItem, ScanResult } from '../models';
import { PrecioPerfilService } from '../precio-perfil.service';
import { BackendStatusService } from '../backend-status.service';
import { ShowroomService } from '../showroom.service';
import {
  ProductoGenericoData,
  ProductoGenericoDialog,
} from '../producto-generico-dialog/producto-generico-dialog';
import { seleccionarTextoAlEnfocar } from '../dom.utils';
import { etiquetaItem } from '../item-etiqueta.util';
import { toastError } from '../toast.utils';

/** Emitido tras cada mutación de {@link CarritoEditor.items} (agregar,
 *  modificar cantidad/descuento, quitar, vaciar, genérico). El host lo usa
 *  para marcar "cambios sin guardar" y mostrar su propio toast — el
 *  componente muestra el suyo con la MISMA data, así ninguno de los dos
 *  necesita conocer al otro (solo el evento). */
export interface CarritoMutacion {
  severity: 'success' | 'info' | 'warn';
  summary: string;
  detail: string;
}

/**
 * Editor autónomo del detalle de un presupuesto/pedido: scan + búsqueda de
 * catálogo (con resultados paginados/ordenables/filtrables por proveedor),
 * tabla editable de ítems (cantidad/descuento in-place, quitar, vaciar,
 * orden) y alta de "producto genérico" (SKU comodín de DUX para líneas que
 * no están en catálogo). El host solo aporta la lista de ítems (two-way),
 * la forma de pago elegida y el mapa de cambios de precio — todo lo demás
 * (agregar por scan/búsqueda, editar, quitar) vive acá.
 *
 * <p>{@link items} es un `model` two-way: el host la posee (la usa para
 * totales, formas de pago, payload y visor); este componente la muta
 * (agregar/quitar/vaciar reemplazan el array, cantidad/descuento mutan
 * in-place para no robarle el foco a `p-inputNumber`). Cada mutación además
 * emite {@link mutacion} para que el host marque "cambios sin guardar" y
 * replique el toast con su propio {@code MessageService}.
 *
 * <p>{@link formaPagoSeleccionada} y {@link cambiosPrecio} son inputs de solo
 * lectura que el host sigue poseyendo (selector global de forma de pago y
 * banner de precios desactualizados) — el componente los necesita para
 * pintar la columna "Precio"/"Subtotal" en la forma elegida y el pill de
 * precio desactualizado por fila.
 */
@Component({
  selector: 'app-carrito-editor',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    FormsModule,
    ButtonModule,
    DialogModule,
    IconFieldModule,
    ImageModule,
    InputIconModule,
    InputNumberModule,
    InputTextModule,
    ProgressSpinnerModule,
    SelectModule,
    TableModule,
    TooltipModule,
    ProductoGenericoDialog,
  ],
  templateUrl: './carrito-editor.html',
})
export class CarritoEditor {
  private readonly toast = inject(MessageService);
  private readonly precioPerfil = inject(PrecioPerfilService);
  private readonly backendStatus = inject(BackendStatusService);
  private readonly api = inject(ShowroomService);
  private readonly destroyRef = inject(DestroyRef);

  /** Lista de ítems — two-way con el host. Solo se reemplaza el array al
   *  AGREGAR o ELIMINAR ítems; cantidad/descuento mutan el objeto in-place (el
   *  propio evento de input dispara la CD del componente y refresca la fila —
   *  no hace falta un tick propio; el host sí tiene el suyo para sus
   *  `computed` de totales). */
  readonly items = model<PresupuestoItem[]>([]);

  /** Forma de pago elegida en el toolbar del host (null = "Todas" / precio de
   *  referencia). Determina la columna "Precio"/"Subtotal" de la tabla. */
  readonly formaPagoSeleccionada = input<FormaPago | null>(null);

  /** Cambios de precio detectados por el host al cargar un presupuesto en
   *  edición (uid → {precioGuardado, precioActual}). Alimenta el pill "precio
   *  desactualizado" por fila. Vacío = todo al día (o modo creación). */
  readonly cambiosPrecio = input<ReadonlyMap<string, CambioPrecio>>(new Map());

  /** Emitido tras cada mutación de {@link items}, para que el host marque
   *  "cambios sin guardar" y replique el toast. */
  readonly mutacion = output<CarritoMutacion>();

  /** Emitido cuando un dialog/overlay PROPIO del componente ("Producto
   *  genérico" o "Ver producto") pasa de abierto a cerrado, por cualquier
   *  camino (confirmar, cancelar, ESC). El componente ya se refoca a sí
   *  mismo para todo lo que puede resolver solo (scan, agregar, vaciar);
   *  este evento existe porque el guard "no robar foco en táctil"
   *  ({@code esTactil}) vive en el host (aplica por igual a SUS propios
   *  dialogs — cliente, crear pedido) y no tiene sentido duplicarlo acá. El
   *  host refoca con su `focusInputAuto()` (respeta ese guard) al recibirlo. */
  readonly dialogCerrado = output<void>();

  /** SKU comodín de DUX para "Producto genérico" — expuesto por el backend
   *  vía /health. Null = el botón queda oculto (backend viejo). */
  readonly skuGenerico = this.backendStatus.skuProductoGenerico;

  // ============================================================
  // Scan / búsqueda
  //
  // SIEMPRE busca en el catálogo local cacheado — nunca dispara una llamada
  // directa a DUX. El presupuestador/carrito asume catálogo sincronizado: el
  // operador arma sobre productos KT GASTRO conocidos, no necesita la
  // freshness real-time de DUX (que paga 7s de rate limit por miss).
  //
  // Flujo:
  //   - 0 resultados → toast "Sin resultados".
  //   - 1 resultado único → cargar via /scan/{sku} (rápido — está en cache,
  //     no toca DUX) para traer pvpConIva + porcIva que /catalogo no expone.
  //   - N resultados → mostrar lista clickable.
  //
  // `scanSeq` evita race conditions cuando se dispara una nueva búsqueda
  // mientras la anterior está en vuelo.
  // ============================================================
  readonly scanInput = viewChild<ElementRef<HTMLInputElement>>('scanInput');
  readonly skuInput = signal('');
  readonly cargandoScan = signal(false);
  /** Resultados de búsqueda por descripción cuando la query no es un código
   *  exacto. Se muestra como lista clickable debajo del input; al elegir uno
   *  se agrega al detalle vía {@link seleccionarResultado}. */
  readonly resultadosBusqueda = signal<CatalogoItem[]>([]);
  /** Total de matches en el backend — puede ser mayor que la lista visible
   *  si todavía no se cargaron todas las páginas. */
  readonly totalResultadosBusqueda = signal(0);
  /** Última query usada — necesaria para paginar. */
  private readonly busquedaQuery = signal('');

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

  /** Filtro por proveedor de los resultados (null = todos). Se aplica en el
   *  backend sobre todo el resultado, igual que el orden. */
  readonly proveedorFiltro = signal<string | null>(null);
  /** Proveedores disponibles para el dropdown del filtro. */
  readonly proveedoresDisponibles = signal<string[]>([]);

  /** True mientras se re-busca por un cambio de orden. Muestra un spinner chico
   *  junto al selector SIN tapar la lista ni deshabilitar el input. */
  readonly reordenando = signal(false);
  /** Última página cargada (0-indexed). */
  private readonly paginaResultados = signal(0);
  /** Loading state del botón "Cargar más" (separado de cargandoScan). */
  readonly cargandoMasResultados = signal(false);
  /** Tamaño de cada página de resultados. */
  private readonly BUSQUEDA_PAGE_SIZE = 50;
  /** Secuencia incremental para descartar respuestas obsoletas — si el operador
   *  dispara una nueva búsqueda antes de que termine la anterior, solo la
   *  última actualiza la UI. */
  private scanSeq = 0;

  /** Cantidades tipeadas en los inputs de la lista de resultados, por SKU.
   *  Vive aparte del array `resultadosBusqueda()` para no mutar el `CatalogoItem`
   *  recibido del backend. Se limpia al cerrar la lista. */
  readonly cantidadesResultados = signal<Record<string, number>>({});

  /** Producto que se está previsualizando en el diálogo "Ver producto".
   *  Null = diálogo cerrado. Usamos el {@link CatalogoItem} de la lista
   *  directamente (sin refetch) — los datos visibles son los mismos. */
  readonly productoPreview = signal<CatalogoItem | null>(null);

  onScanEnter(): void {
    const query = this.skuInput().trim();
    if (!query) return;
    this.skuInput.set('');
    this.resultadosBusqueda.set([]);
    // Reset de cantidades tipeadas — corresponden a la búsqueda anterior y
    // no deberían sobrevivir a una nueva query.
    this.cantidadesResultados.set({});
    // Cada búsqueda NUEVA arranca sin el filtro de proveedor anterior (sino
    // quedaba "pegado"). Los re-search por cambio de filtro/orden no pasan por
    // acá, así que se preservan.
    this.proveedorFiltro.set(null);
    // El dropdown de proveedores se acota a lo buscado.
    this.cargarProveedores(query);
    const seq = ++this.scanSeq;
    this.cargandoScan.set(true);
    this.buscarEnCatalogo(query, seq);
  }

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
      const seq = ++this.scanSeq;
      this.reordenando.set(true);
      // Refinamiento de la lista: nunca auto-agregar aunque quede 1 resultado.
      this.buscarEnCatalogo(query, seq, false);
    }
  }

  /** Cambia el filtro por proveedor y re-ejecuta la búsqueda desde la primera
   *  página (el filtro se aplica en el backend sobre todo el resultado). */
  cambiarProveedorFiltro(proveedor: string | null): void {
    if (this.proveedorFiltro() === proveedor) return;
    this.proveedorFiltro.set(proveedor);
    const query = this.busquedaQuery();
    if (query) {
      const seq = ++this.scanSeq;
      this.reordenando.set(true);
      // Refinamiento de la lista: nunca auto-agregar aunque quede 1 resultado.
      this.buscarEnCatalogo(query, seq, false);
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

  private buscarEnCatalogo(query: string, seq: number, autoAgregarSiUnico = true): void {
    this.busquedaQuery.set(query);
    this.paginaResultados.set(0);
    const { sortField, sortOrder } = this.ordenResultadosParams();
    this.api.buscarCatalogo(query, 0, this.BUSQUEDA_PAGE_SIZE, sortField, sortOrder, this.proveedorFiltro()).subscribe({
      next: (page) => {
        if (seq !== this.scanSeq) return;
        this.cargandoScan.set(false);
        this.reordenando.set(false);
        if (page.items.length === 0) {
          // Posible producto fuera del catálogo cacheado o catálogo desactualizado.
          // Mostramos un mensaje útil para que el operador sepa qué chequear.
          this.toast.add({
            severity: 'warn',
            summary: 'Sin resultados',
            detail: `No encontré "${query}" en el catálogo. Si es un producto nuevo, sincronizá el catálogo desde el showroom.`,
            life: 6000,
          });
          this.resultadosBusqueda.set([]);
          this.totalResultadosBusqueda.set(0);
        } else if (autoAgregarSiUnico && page.items.length === 1 && page.total === 1) {
          // Único resultado en todo el catálogo — lo agregamos directo.
          // Solo en la búsqueda inicial (el operador tipeó una query): al
          // refinar filtro/orden NO auto-agregamos, sino el cambio de filtro
          // metía el producto al detalle (o le sumaba cantidad si ya estaba).
          this.totalResultadosBusqueda.set(1);
          this.seleccionarResultado(page.items[0].sku);
          return;
        } else {
          this.resultadosBusqueda.set(page.items);
          this.totalResultadosBusqueda.set(page.total);
        }
        this.focusScanInput();
      },
      error: (err) => {
        if (seq !== this.scanSeq) return;
        this.cargandoScan.set(false);
        this.reordenando.set(false);
        toastError(this.toast, 'Búsqueda', err, 'No se pudo buscar.');
        this.focusScanInput();
      },
    });
  }

  /** Pagina siguiente de los resultados ya cargados — appendea sin recargar. */
  cargarMasResultados(): void {
    if (this.cargandoMasResultados()) return;
    if (this.resultadosBusqueda().length >= this.totalResultadosBusqueda()) return;
    this.cargandoMasResultados.set(true);
    const seq = this.scanSeq;
    const nextPage = this.paginaResultados() + 1;
    const { sortField, sortOrder } = this.ordenResultadosParams();
    this.api.buscarCatalogo(this.busquedaQuery(), nextPage, this.BUSQUEDA_PAGE_SIZE, sortField, sortOrder, this.proveedorFiltro())
      .subscribe({
        next: (page) => {
          if (seq !== this.scanSeq) return;
          this.cargandoMasResultados.set(false);
          this.paginaResultados.set(nextPage);
          this.resultadosBusqueda.set([...this.resultadosBusqueda(), ...page.items]);
          this.focusScanInput();
        },
        error: (err) => {
          if (seq !== this.scanSeq) return;
          this.cargandoMasResultados.set(false);
          this.focusScanInput();
          toastError(this.toast, 'Búsqueda', err, 'No se pudieron cargar más resultados.');
        },
      });
  }

  /** Cierra la lista de resultados (botón ✕) y devuelve el foco al input.
   *  Limpia también las cantidades tipeadas — si el operador busca otra cosa
   *  después, los inputs arrancan en el default sin sorpresas heredadas. */
  cerrarResultadosBusqueda(): void {
    this.resultadosBusqueda.set([]);
    this.cantidadesResultados.set({});
    this.focusScanInput();
  }

  /** El operador eligió un item de la lista de resultados — lo cargamos via
   *  `/scan/{sku}` para traer todos los datos (precios c/IVA + s/IVA, stock,
   *  imagen) y lo agregamos al detalle. Acepta `cantidad` opcional para que
   *  el botón "Agregar" inline de cada fila pueda mandar varias unidades de
   *  una sola vez.
   *
   *  <p>La lista de resultados queda ABIERTA tras agregar — el operador
   *  puede sumar varios productos del mismo set de resultados sin tener que
   *  volver a buscar. La cantidad del item recién agregado se resetea a 1
   *  para que un siguiente click no duplique la cantidad anterior. */
  seleccionarResultado(sku: string, cantidad: number = 1): void {
    this.cargandoScan.set(true);
    const seq = ++this.scanSeq;
    const cant = Number.isFinite(cantidad) && cantidad > 0 ? Math.floor(cantidad) : 1;
    // publicarVisor=false: el presupuestador es un flujo paralelo a la
    // atención del cliente — los productos cotizados no deben aparecer en
    // la pantalla /visor que mira el cliente.
    this.api.scan(sku, false).subscribe({
      next: (res) => {
        if (seq !== this.scanSeq) return;
        this.cargandoScan.set(false);
        this.agregarItem(res, cant);
        // Reset de la cantidad del sku recién agregado — sin esto, si el
        // operador apreta "Agregar" 3 veces con cantidad=5, agregaría 5
        // primero y luego cada click pondría 5 más (el input no se limpia).
        this.cantidadesResultados.update((m) => {
          const nm = { ...m };
          delete nm[sku];
          return nm;
        });
        this.focusScanInput();
      },
      error: (err) => {
        if (seq !== this.scanSeq) return;
        this.cargandoScan.set(false);
        this.focusScanInput();
        toastError(this.toast, 'Cargar producto', err, 'No se pudo cargar el producto.');
      },
    });
  }

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
   *  stock: el presupuesto no descuenta stock, así que el operador puede cargar
   *  la cantidad que quiera; el detalle muestra un pill amarillo "excede stock"
   *  si la cantidad supera el disponible. Cap alto solo para evitar absurdos. */
  cantidadMaximaResultado(_r: CatalogoItem): number {
    return 9999;
  }

  agregarResultado(sku: string): void {
    const cant = this.cantidadResultado(sku);
    this.seleccionarResultado(sku, cant);
  }

  /** Abre el diálogo de preview con la foto grande + datos del producto.
   *  El operador puede ver mejor el producto antes de decidir si lo agrega
   *  al detalle. El botón "Agregar" del diálogo respeta la cantidad
   *  tipeada en la fila de la lista. */
  verResultado(r: CatalogoItem): void {
    this.productoPreview.set(r);
  }

  /** Cierra el diálogo de preview. */
  cerrarProductoPreview(): void {
    this.productoPreview.set(null);
  }

  /** Confirma "Agregar al detalle" desde el diálogo de preview: respeta la
   *  cantidad ya tipeada en la fila del listado (default 1) y cierra el
   *  diálogo después. */
  agregarDesdePreview(): void {
    const r = this.productoPreview();
    if (!r) return;
    this.agregarResultado(r.sku);
    this.cerrarProductoPreview();
  }

  /** Agrega un ítem escaneado/buscado al detalle. Si el SKU ya existe, le
   *  suma la cantidad (merge, típico al re-escanear); si no, crea una línea
   *  nueva. Rechaza el SKU comodín de "producto genérico" (se carga por el
   *  dialog dedicado, no por scan directo — sino la descripción genérica de
   *  DUX pisaría la tipeada, y el merge por SKU mezclaría cantidades de
   *  genéricos distintos, que todos comparten el mismo SKU). */
  private agregarItem(res: ScanResult, cantidad: number = 1): void {
    const cant = cantidad > 0 ? cantidad : 1;
    if (this.skuGenerico() && res.sku === this.skuGenerico()) {
      this.warn('Para cargar un producto que no está en catálogo, usá el botón "Producto genérico".');
      return;
    }
    const actuales = this.items();
    // Si ya existe el SKU, sumarle cantidad (caso típico: re-escanear).
    const existente = actuales.find((it) => it.sku === res.sku);
    if (existente) {
      const nuevaCantidad = existente.cantidad + cant;
      this.items.set(actuales.map((it) =>
        it.sku === res.sku ? { ...it, cantidad: nuevaCantidad } : it));
      this.emitirMutacion('info', 'Cantidad actualizada',
        `${etiquetaItem(existente)}: ${existente.cantidad}u → ${nuevaCantidad}u`);
      return;
    }
    const uid = `${res.sku}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const nuevo: PresupuestoItem = {
      ...res,
      uid,
      cantidad: cant,
      descuentoPorcentaje: 0,
    };
    this.items.set([...actuales, nuevo]);
    this.emitirMutacion('success', 'Producto agregado',
      `${etiquetaItem(nuevo)}${cant > 1 ? ` (${cant}u)` : ''}`);
  }

  /** Orden de visualización del detalle. `null` = orden de carga. Solo afecta
   *  el render — no depende de la mutación in-place a propósito: editar
   *  cantidad/descuento no debe reordenar la grilla en vivo. */
  readonly ordenItems = signal<{ campo: 'producto' | 'precio'; dir: 'asc' | 'desc' } | null>(null);

  /** Detalle ordenado para el render. Copia ordenada por descripción
   *  (producto) o por el precio de referencia mostrado. */
  readonly itemsOrdenados = computed<PresupuestoItem[]>(() => {
    const lista = this.items();
    const orden = this.ordenItems();
    if (!orden) return lista;
    const factor = orden.dir === 'asc' ? 1 : -1;
    return [...lista].sort((a, b) => {
      if (orden.campo === 'producto') {
        return (a.descripcion ?? '').localeCompare(b.descripcion ?? '', 'es', { sensitivity: 'base' }) * factor;
      }
      return (this.precioMostrado(a) - this.precioMostrado(b)) * factor;
    });
  });

  /** Cicla el orden del detalle para un campo: asc → desc → sin orden (carga). */
  ordenarItemsPor(campo: 'producto' | 'precio'): void {
    const actual = this.ordenItems();
    if (!actual || actual.campo !== campo) {
      this.ordenItems.set({ campo, dir: 'asc' });
    } else if (actual.dir === 'asc') {
      this.ordenItems.set({ campo, dir: 'desc' });
    } else {
      this.ordenItems.set(null);
    }
  }

  /** Ícono del encabezado de orden de un campo: flecha según dirección, o neutro. */
  iconoOrdenItems(campo: 'producto' | 'precio'): string {
    const o = this.ordenItems();
    if (!o || o.campo !== campo) return 'pi pi-sort-alt';
    return o.dir === 'asc' ? 'pi pi-sort-amount-up-alt' : 'pi pi-sort-amount-down';
  }

  /** True si el producto es de maquinaria (rubro configurable que cotiza sin
   *  IVA) — marca la fila con un badge/resaltado. */
  esRubroMaquinaria(rubro: string | null | undefined): boolean {
    return this.precioPerfil.rubroCotizaSinIva(rubro);
  }

  /** Precio de REFERENCIA unitario de un producto (forma destacada según el
   *  perfil de su rubro) — mismo criterio que scan/visor/showroom. Delega en
   *  el servicio compartido (única fuente, ver {@link PrecioPerfilService.precioMostrado}). */
  precioMostrado(
    r: {
      pvpKtGastroConIva: number | null;
      pvpKtGastroSinIva: number | null;
      porcIva?: number | null;
      rubro?: string | null;
    },
  ): number {
    return this.precioPerfil.precioMostrado(r);
  }

  /** Precio unitario a MOSTRAR según la forma elegida en el host; con "Todas"
   *  cae al precio de referencia ({@link precioMostrado}). Solo visual. Delega
   *  en el servicio compartido (única fuente, ver
   *  {@link PrecioPerfilService.precioVisualItem}). */
  precioVisualItem(it: {
    pvpKtGastroConIva: number | null;
    pvpKtGastroSinIva: number | null;
    porcIva?: number | null;
    rubro?: string | null;
  }): number {
    return this.precioPerfil.precioVisualItem(it, this.formaPagoSeleccionada());
  }

  /** Subtotal por línea EN LA FORMA elegida (solo visual): precio visual ×
   *  (1 − desc) × cantidad. Con "Todas" coincide con el total efectivo. */
  subtotalVisualItem(it: PresupuestoItem): number {
    const desc = it.descuentoPorcentaje ?? 0;
    return this.precioVisualItem(it) * (1 - desc / 100) * it.cantidad;
  }

  /** Cambio de precio detectado para un ítem (por uid), o undefined si su
   *  precio sigue igual al guardado. Pinta el pill "precio desactualizado". */
  cambioPrecioDe(uid: string): CambioPrecio | undefined {
    return this.cambiosPrecio().get(uid);
  }

  /** Clase del input "% Desc." por línea: azul cuando la línea tiene
   *  descuento, neutro cuando es 0. */
  claseInputDescuentoItem(descuento: number | null | undefined): string {
    const base = 'text-center descuento-input';
    return (descuento ?? 0) > 0
      ? `${base} font-semibold text-sky-600 dark:text-sky-400`
      : `${base} text-muted-color`;
  }

  /** Selecciona el contenido del input al enfocarlo (el "0%" no se concatena
   *  al tipear). Lógica compartida en {@link seleccionarTextoAlEnfocar}. */
  protected readonly seleccionarAlEnfocar = seleccionarTextoAlEnfocar;

  /** Tope de cantidad para el input. NO se topea al stock: el operador puede
   *  cargar la cantidad que quiera; un pill amarillo avisa si excede el
   *  disponible. Cap alto solo para evitar cantidades absurdas. */
  cantidadMaximaDe(_it: PresupuestoItem): number {
    return 9999;
  }

  actualizarCantidad(it: PresupuestoItem, valor: number): void {
    if (!Number.isFinite(valor) || valor <= 0) valor = 1;
    if (it.cantidad === valor) return;
    const prev = it.cantidad;
    it.cantidad = valor;
    this.emitirMutacion('info', 'Cantidad actualizada',
      `${etiquetaItem(it)}: ${prev}u → ${valor}u`);
  }

  actualizarDescuento(it: PresupuestoItem, valor: number): void {
    if (!Number.isFinite(valor) || valor < 0) valor = 0;
    if (valor > 100) valor = 100;
    if ((it.descuentoPorcentaje ?? 0) === valor) return;
    it.descuentoPorcentaje = valor;
    this.emitirMutacion('info', 'Descuento actualizado',
      `${etiquetaItem(it)}: ${valor}%`);
  }

  /** Quita un ítem del detalle. NO toca el map de "cambios de precio" del
   *  host — el host lo purga solo (por uid vivo) vía un `effect`. */
  eliminarItem(uid: string): void {
    const it = this.items().find((x) => x.uid === uid);
    this.items.set(this.items().filter((x) => x.uid !== uid));
    if (it) {
      this.emitirMutacion('warn', 'Producto quitado', etiquetaItem(it));
    }
  }

  /** Vacía todo el detalle. Igual que {@link eliminarItem}, no toca el map de
   *  "cambios de precio" del host (se purga solo). Devuelve el foco al scan
   *  input de forma incondicional (mismo comportamiento que el `vaciar()`
   *  original, que llamaba `focusInput()` directo). */
  vaciar(): void {
    const cantidad = this.items().length;
    this.items.set([]);
    this.focusScanInput();
    if (cantidad > 0) {
      this.emitirMutacion('warn', 'Detalle vaciado',
        `Se quitaron ${cantidad} ${cantidad === 1 ? 'producto' : 'productos'}.`);
    }
  }

  // ============================================================
  // Producto genérico — alta a mano de una línea con el SKU comodín de DUX.
  // ============================================================
  readonly mostrarDialogGenerico = signal(false);

  constructor() {
    // Proveedores para el dropdown del filtro de búsqueda.
    this.cargarProveedores();

    // Detecta la transición abierto→cerrado de CUALQUIERA de los dos
    // dialogs/overlays propios ("Producto genérico" y "Ver producto") y
    // emite `dialogCerrado` para que el host refoque el scan input con su
    // guard táctil — réplica acotada del effect unificado que tenía el host
    // sobre `algunDialogAbierto()` antes de este refactor (ese effect incluía
    // estos mismos dos, junto con los propios del host).
    let habiaDialogAbierto = false;
    effect(() => {
      const abierto = this.mostrarDialogGenerico() || this.productoPreview() != null;
      if (habiaDialogAbierto && !abierto) {
        this.dialogCerrado.emit();
      }
      habiaDialogAbierto = abierto;
    });
  }

  abrirGenerico(): void {
    if (!this.skuGenerico()) {
      this.warn('El SKU comodín no está configurado en el backend.');
      return;
    }
    this.mostrarDialogGenerico.set(true);
  }

  onAgregarGenerico(data: ProductoGenericoData): void {
    const sku = this.skuGenerico();
    if (!sku) {
      this.warn('El SKU comodín no está configurado en el backend.');
      return;
    }
    const uid = `gen-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const sinIva = data.precioConIva / (1 + data.porcIva / 100);
    const nuevo: PresupuestoItem = {
      sku,
      descripcion: data.descripcion,
      rubro: data.maquinaria ? 'MAQUINAS INDUSTRIALES' : null,
      pvpKtGastroConIva: data.precioConIva,
      pvpKtGastroSinIva: sinIva,
      porcIva: data.porcIva,
      stockTotal: null,
      habilitado: true,
      imagenUrl: null,
      sincronizadoAt: new Date().toISOString(),
      uid,
      cantidad: data.cantidad,
      descuentoPorcentaje: 0,
      generico: true,
      comentarios: data.descripcion,
    };
    this.items.set([...this.items(), nuevo]);
    this.mostrarDialogGenerico.set(false);
    this.emitirMutacion('success', 'Producto genérico agregado',
      `${etiquetaItem(nuevo)}${data.cantidad > 1 ? ` (${data.cantidad}u)` : ''}`);
  }

  /** Devuelve el foco al input de scan — incondicional (sin guard táctil): la
   *  pistola QR debe seguir alimentando el input aunque el dispositivo sea
   *  táctil. Lo usa el propio componente (tras agregar/buscar/vaciar) y el
   *  host (tras cerrar SUS propios diálogos), vía la ref `#carrito`. */
  focusScanInput(): void {
    setTimeout(() => this.scanInput()?.nativeElement.focus(), 0);
  }

  private warn(detail: string): void {
    this.toast.add({ severity: 'warn', summary: 'Atención', detail, life: 5000 });
  }

  /** Notifica al host una mutación. NO muestra un toast propio acá: el
   *  `MessageService` de esta app es un singleton único (provisto una sola
   *  vez en `app.ts`, ningún componente lo re-provee) — mostrar un toast acá
   *  Y otro en el host (`notificarMutacion`) duplicaría cada aviso en
   *  pantalla. El host es la única fuente del toast + `hayCambiosSinGuardar`. */
  private emitirMutacion(severity: 'success' | 'info' | 'warn', summary: string, detail: string): void {
    this.mutacion.emit({ severity, summary, detail });
  }
}
