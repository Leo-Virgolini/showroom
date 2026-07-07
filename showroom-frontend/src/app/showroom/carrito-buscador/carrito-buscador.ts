import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  effect,
  inject,
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
import { TooltipModule } from 'primeng/tooltip';
import { CarritoMutacion, CatalogoItem, PresupuestoItem, ScanResult } from '../models';
import { PrecioPerfilService } from '../precio-perfil.service';
import { BackendStatusService } from '../backend-status.service';
import { ShowroomService } from '../showroom.service';
import {
  ProductoGenericoData,
  ProductoGenericoDialog,
} from '../producto-generico-dialog/producto-generico-dialog';
import { etiquetaItem } from '../item-etiqueta.util';
import { toastError } from '../toast.utils';

/**
 * Scan + búsqueda de catálogo para armar el detalle de un presupuesto/pedido:
 * input de código/descripción/EAN, resultados paginados/ordenables/filtrables
 * por proveedor, preview "Ver producto" y alta de "producto genérico" (SKU
 * comodín de DUX). Es la mitad "búsqueda" del viejo `carrito-editor` (la otra
 * mitad, la tabla editable, vive en `carrito-tabla`).
 *
 * <p>{@link items} es un `model` two-way que POSEE el host y comparte con
 * `carrito-tabla`: este componente AGREGA (por scan/búsqueda/genérico), la tabla
 * edita/quita. Cada alta emite {@link mutacion} para que el host marque "cambios
 * sin guardar" y muestre el toast. Los dialogs propios ("Producto genérico" y
 * "Ver producto") emiten {@link dialogCerrado} al cerrarse para que el host
 * devuelva el foco con su guard táctil.
 */
@Component({
  selector: 'app-carrito-buscador',
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
    TooltipModule,
    ProductoGenericoDialog,
  ],
  templateUrl: './carrito-buscador.html',
})
export class CarritoBuscador {
  private readonly toast = inject(MessageService);
  private readonly precioPerfil = inject(PrecioPerfilService);
  private readonly backendStatus = inject(BackendStatusService);
  private readonly api = inject(ShowroomService);
  private readonly destroyRef = inject(DestroyRef);

  /** Lista de ítems — two-way con el host, compartida con `carrito-tabla`.
   *  Este componente solo AGREGA (reemplaza el array); la tabla edita/quita. */
  readonly items = model<PresupuestoItem[]>([]);

  /** Emitido tras cada alta al detalle, para que el host marque "cambios sin
   *  guardar" y replique el toast. */
  readonly mutacion = output<CarritoMutacion>();

  /** Emitido cuando un dialog/overlay PROPIO ("Producto genérico" o "Ver
   *  producto") pasa de abierto a cerrado. El componente ya se refoca a sí
   *  mismo para lo que resuelve solo (scan, agregar); este evento existe porque
   *  el guard "no robar foco en táctil" vive en el host. */
  readonly dialogCerrado = output<void>();

  /** SKU comodín de DUX para "Producto genérico" — expuesto por el backend
   *  vía /health. Null = el botón queda oculto (backend viejo). */
  readonly skuGenerico = this.backendStatus.skuProductoGenerico;

  // ============================================================
  // Scan / búsqueda
  //
  // SIEMPRE busca en el catálogo local cacheado — nunca dispara una llamada
  // directa a DUX. El presupuestador/carrito asume catálogo sincronizado.
  //
  // Flujo:
  //   - 0 resultados → toast "Sin resultados".
  //   - 1 resultado único → cargar via /scan/{sku} (rápido — está en cache).
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

  /** Producto genérico — alta a mano de una línea con el SKU comodín de DUX. */
  readonly mostrarDialogGenerico = signal(false);

  constructor() {
    // Proveedores para el dropdown del filtro de búsqueda.
    this.cargarProveedores();

    // Detecta la transición abierto→cerrado de CUALQUIERA de los dos
    // dialogs/overlays propios ("Producto genérico" y "Ver producto") y
    // emite `dialogCerrado` para que el host refoque el scan input con su
    // guard táctil.
    let habiaDialogAbierto = false;
    effect(() => {
      const abierto = this.mostrarDialogGenerico() || this.productoPreview() != null;
      if (habiaDialogAbierto && !abierto) {
        this.dialogCerrado.emit();
      }
      habiaDialogAbierto = abierto;
    });
  }

  onScanEnter(): void {
    const query = this.skuInput().trim();
    if (!query) return;
    this.skuInput.set('');
    this.resultadosBusqueda.set([]);
    // Reset de cantidades tipeadas — corresponden a la búsqueda anterior.
    this.cantidadesResultados.set({});
    // Cada búsqueda NUEVA arranca sin el filtro de proveedor anterior.
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
   *  Limpia también las cantidades tipeadas. */
  cerrarResultadosBusqueda(): void {
    this.resultadosBusqueda.set([]);
    this.cantidadesResultados.set({});
    this.focusScanInput();
  }

  /** El operador eligió un item de la lista de resultados — lo cargamos via
   *  `/scan/{sku}` para traer todos los datos (precios c/IVA + s/IVA, stock,
   *  imagen) y lo agregamos al detalle. La lista queda ABIERTA tras agregar. */
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
        // Reset de la cantidad del sku recién agregado.
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
   *  stock: el presupuesto no descuenta stock. Cap alto solo para evitar absurdos. */
  cantidadMaximaResultado(_r: CatalogoItem): number {
    return 9999;
  }

  agregarResultado(sku: string): void {
    const cant = this.cantidadResultado(sku);
    this.seleccionarResultado(sku, cant);
  }

  /** Abre el diálogo de preview con la foto grande + datos del producto. */
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
   *  nueva. Rechaza el SKU comodín de "producto genérico". */
  private agregarItem(res: ScanResult, cantidad: number = 1): void {
    const cant = cantidad > 0 ? cantidad : 1;
    if (this.skuGenerico() && res.sku === this.skuGenerico()) {
      this.warn('Para cargar un producto que no está en catálogo, usá el botón "Producto genérico".');
      return;
    }
    const actuales = this.items();
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

  /** True si el producto es de maquinaria (rubro configurable que cotiza sin
   *  IVA) — marca la fila con un badge/resaltado. */
  esRubroMaquinaria(rubro: string | null | undefined): boolean {
    return this.precioPerfil.rubroCotizaSinIva(rubro);
  }

  /** Precio de REFERENCIA unitario de un producto (forma destacada según el
   *  perfil de su rubro) — mismo criterio que scan/visor/showroom. */
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

  /** Devuelve el foco al input de scan — incondicional (sin guard táctil): la
   *  pistola QR debe seguir alimentando el input aunque el dispositivo sea
   *  táctil. Lo usa el propio componente (tras agregar/buscar) y el host (tras
   *  cerrar SUS propios diálogos y tras vaciar la tabla), vía la ref. */
  focusScanInput(): void {
    setTimeout(() => this.scanInput()?.nativeElement.focus(), 0);
  }

  private warn(detail: string): void {
    this.toast.add({ severity: 'warn', summary: 'Atención', detail, life: 5000 });
  }

  /** Notifica al host una mutación. NO muestra un toast propio acá: el
   *  `MessageService` es un singleton único — el host es la única fuente del
   *  toast + `hayCambiosSinGuardar`. */
  private emitirMutacion(severity: 'success' | 'info' | 'warn', summary: string, detail: string): void {
    this.mutacion.emit({ severity, summary, detail });
  }
}
