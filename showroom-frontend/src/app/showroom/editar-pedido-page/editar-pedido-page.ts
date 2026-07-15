import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { ConfirmationService, MessageService } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { InputNumberModule } from 'primeng/inputnumber';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { TooltipModule } from 'primeng/tooltip';
import { CambioPrecio, FormaPago, PedidoDetalle, PresupuestoItem } from '../models';
import { PrecioPerfilService } from '../precio-perfil.service';
import { BackendStatusService } from '../backend-status.service';
import { ShowroomService } from '../showroom.service';
import { pedidoItemsAPresupuestoItems } from '../pedido-a-carrito.util';
import {
  calcularIndiceMejorPrecio,
  iconoFormaReferencia,
  redondearMoneda,
} from '../precio-referencia.util';
import { CarritoBuscador } from '../carrito-buscador/carrito-buscador';
import { CarritoTabla } from '../carrito-tabla/carrito-tabla';
import { CarritoMutacion } from '../models';
import {
  CrearPedidoDialog,
  PedidoClientePrefill,
  PedidoItemEntrada,
} from '../crear-pedido-dialog/crear-pedido-dialog';
import { PageHeader } from '../page-header/page-header';
import { toastError } from '../toast.utils';
import { seleccionarTextoAlEnfocar } from '../dom.utils';
import { HasUnsavedChanges } from '../presupuestos-page/unsaved-changes.guard';

/** Forma de pago con su precio final calculado para los ítems actuales, más
 *  los metadatos que consume el chip del footer (color rotativo + ganadora). */
interface FormaChipEditor {
  id: number;
  nombre: string;
  /** Índice en el orden original de `formasPago()` — fija el color rotativo. */
  indiceOriginal: number;
  /** True si es la forma más barata del comparativo. */
  esMejorPrecio: boolean;
  precioFinal: number | null;
}

/**
 * Pantalla `pedidos/editar/:id`: carga un pedido ya cargado en DUX, hidrata
 * el `carrito-editor` con sus ítems (precios CONGELADOS del pedido, no del
 * catálogo actual — mismo criterio que editar un presupuesto), deja
 * modificar cantidades/descuentos/forma de pago y, al guardar, abre el
 * `crear-pedido-dialog` en su variante "editar pedido" (sin presupuesto,
 * con {@link PedidoItemEntrada} propios). Confirmar ahí dispara
 * `regenerarPedidoDesdePedido`: crea un pedido NUEVO en DUX y anula el
 * viejo — no hay un PUT que edite el pedido in-place (DUX no lo permite).
 *
 * <p>Implementa {@link HasUnsavedChanges} para que {@code unsavedChangesGuard}
 * avise al operador si intenta salir con ediciones sin persistir.
 */
@Component({
  selector: 'app-editar-pedido-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    FormsModule,
    ButtonModule,
    CardModule,
    InputNumberModule,
    ProgressSpinnerModule,
    TooltipModule,
    CarritoBuscador,
    CarritoTabla,
    CrearPedidoDialog,
    PageHeader,
  ],
  templateUrl: './editar-pedido-page.html',
  styleUrl: './editar-pedido-page.scss',
})
export class EditarPedidoPage implements HasUnsavedChanges {
  private readonly api = inject(ShowroomService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly precioPerfil = inject(PrecioPerfilService);
  private readonly backendStatus = inject(BackendStatusService);
  private readonly toast = inject(MessageService);
  private readonly confirmationService = inject(ConfirmationService);
  private readonly destroyRef = inject(DestroyRef);

  /** Id del pedido a editar (parseado del `:id` de la ruta). Null solo en el
   *  instante antes de validar la URL (nunca llega a renderizarse: si el
   *  parámetro es inválido, redirigimos a `/pedidos` en el constructor). */
  readonly pedidoId = signal<number | null>(null);

  /** Detalle del pedido cargado — fuente del estado (ENVIADO/ANULADO/etc.),
   *  los datos de cliente que el dialog reutiliza, y el snapshot de ítems
   *  original (los editables viven en {@link items}). */
  readonly pedido = signal<PedidoDetalle | null>(null);

  /** Ítems editables — hidratados desde el pedido con precios CONGELADOS
   *  (ver {@link pedidoItemsAPresupuestoItems}). El `carrito-editor` los
   *  muta in-place (cantidad/descuento) o reemplaza el array (agregar/quitar). */
  readonly items = signal<PresupuestoItem[]>([]);

  /** Forma de pago elegida para ver el total en vivo y para el dialog. Se
   *  resuelve una única vez desde `pedido().formaPagoId` en cuanto el
   *  pedido y la lista de formas estén disponibles (ver constructor); a
   *  partir de ahí el operador la puede cambiar libremente desde el selector. */
  readonly formaPagoSeleccionada = signal<FormaPago | null>(null);
  /** True una vez resuelta la forma inicial — evita que el effect de
   *  resolución pise una elección posterior del operador. */
  private readonly formaResuelta = signal(false);

  /** Formas de pago activas — fuente compartida (misma que presupuestos/showroom). */
  readonly formasPago = this.precioPerfil.formasPago;

  readonly cargando = signal(true);
  readonly hayCambiosSinGuardar = signal(false);
  readonly mostrarDialog = signal(false);

  /** True si al menos un ítem se re-cotizó a la lista vigente al cargar el
   *  pedido (ver {@link recotizarItemsViejos}) — pedidos anteriores a
   *  `precioListaConIva` no guardan el PVP pre-forma original. Dispara el
   *  aviso en el template. */
  readonly huboRecotizacion = signal(false);

  /** Cambios de precio detectados al abrir el pedido: uid del ítem →
   *  {precioGuardado, precioActual}. Se llena en {@link enriquecerYDetectarCambios}
   *  comparando el precio CONGELADO del pedido contra el catálogo local (sin
   *  tocar DUX) y se vacía cuando el operador aplica "Actualizar precios".
   *  Alimenta el pill por fila (vía el input `cambiosPrecio` de `carrito-tabla`)
   *  y el banner de aviso. Vacío = todo al día. */
  readonly cambiosPrecio = signal<Map<string, CambioPrecio>>(new Map());

  /** Cantidad de ítems con precio desactualizado — gatilla el banner. */
  readonly cantidadPreciosCambiados = computed(() => this.cambiosPrecio().size);

  /** True mientras corre el lookup de "Actualizar precios" (deshabilita el botón). */
  readonly actualizandoPrecios = signal(false);

  /** Contador que se incrementa en cada mutación in-place (cantidad/descuento)
   *  del `carrito-editor` — fuerza el recompute de {@link total} sin necesidad
   *  de reemplazar el array `items` (mismo patrón que presupuestos-page). */
  private readonly itemsTick = signal(0);

  /** Ref al `carrito-buscador` — para refocar el scan input tras cargar el
   *  pedido y tras cerrar sus propios diálogos. */
  readonly buscador = viewChild(CarritoBuscador);

  /** Ref al footer sticky — su alto se refleja en {@link footerHeight} vía
   *  ResizeObserver para calcular el padding-bottom del main (los chips de
   *  formas pueden envolver a 2+ líneas). */
  readonly footerSticky = viewChild<ElementRef<HTMLElement>>('footerSticky');
  /** Alto del footer sticky en px (default aproximado hasta la 1ª medición). */
  readonly footerHeight = signal(72);

  /** Total en vivo con la forma de pago elegida — mismo cálculo que el
   *  footer de presupuestos-page ({@link PrecioPerfilService.precioVisualItem}
   *  por ítem, con el descuento individual de la línea aplicado encima). */
  readonly total = computed(() => {
    this.itemsTick();
    return this.totalConForma(this.formaPagoSeleccionada());
  });

  /** Total del pedido cotizado con una forma de pago dada — mismo cálculo que
   *  {@link total} pero parametrizado, para comparar todas las formas en el
   *  footer. Usa {@link PrecioPerfilService.precioVisualItem} (resuelve
   *  recargo/IVA por perfil del rubro) y aplica el descuento de línea encima. */
  private totalConForma(forma: FormaPago | null): number {
    return this.items().reduce((acc, it) => {
      const precio = this.precioPerfil.precioVisualItem(it, forma);
      const desc = it.descuentoPorcentaje ?? 0;
      return acc + precio * it.cantidad * (1 - desc / 100);
    }, 0);
  }

  /** Subtotal BRUTO en la forma elegida (sin los descuentos por línea) — base
   *  para mostrar el precio tachado cuando hay descuento. */
  readonly subtotalVisual = computed(() => {
    this.itemsTick();
    const forma = this.formaPagoSeleccionada();
    return this.items().reduce(
      (acc, it) => acc + this.precioPerfil.precioVisualItem(it, forma) * it.cantidad, 0);
  });

  /** Ahorro en pesos por los descuentos por línea (bruto − neto). */
  readonly descuentoVisualMonto = computed(() => this.subtotalVisual() - this.total());

  /** % EFECTIVO del descuento sobre el subtotal BRUTO de lista (con IVA),
   *  independiente de la forma de pago. Cuando todas las líneas llevan el mismo
   *  descuento coincide con ese %; si difieren, es el promedio ponderado por el
   *  peso de cada línea. Es lo que muestra el input "Desc. global"; si el
   *  operador lo edita, ese % se COPIA a cada ítem (no se suma encima). */
  readonly descuentoGlobal = computed(() => {
    this.itemsTick();
    const items = this.items();
    const bruto = items.reduce((a, it) => a + (it.pvpKtGastroConIva ?? 0) * it.cantidad, 0);
    if (bruto <= 0) return 0;
    const desc = items.reduce(
      (a, it) => a + (it.pvpKtGastroConIva ?? 0) * it.cantidad * ((it.descuentoPorcentaje ?? 0) / 100), 0);
    return (desc / bruto) * 100;
  });

  /** Precio final de cada forma de pago activa para los ítems actuales.
   *  Alimenta el comparativo del footer y el resalte de "mejor precio". */
  readonly formasPagoCalculadas = computed<FormaChipEditor[]>(() => {
    this.itemsTick();
    return this.formasPago().map((f, i) => ({
      id: f.id,
      nombre: f.nombre,
      indiceOriginal: i,
      esMejorPrecio: false,
      precioFinal: redondearMoneda(this.totalConForma(f)),
    }));
  });

  /** Índice (en {@link formasPagoCalculadas}) de la forma más barata, o -1 si
   *  no hay ganadora clara (misma lógica que el presupuestador/PDF). */
  readonly indiceMejorPrecio = computed(() =>
    calcularIndiceMejorPrecio(this.formasPagoCalculadas()));

  /** Chips de formas para el footer: mejor precio primero (resaltado verde),
   *  el resto por precio ascendente. Cada uno conserva su color rotativo. */
  readonly formasPagoFooter = computed<FormaChipEditor[]>(() => {
    const todas = this.formasPagoCalculadas();
    if (todas.length === 0) return [];
    const idxMejor = this.indiceMejorPrecio();
    const decoradas = todas.map((f, i) => ({ ...f, esMejorPrecio: i === idxMejor }));
    const porPrecio = (a: FormaChipEditor, b: FormaChipEditor) =>
      (a.precioFinal ?? Infinity) - (b.precioFinal ?? Infinity);
    if (idxMejor >= 0) {
      const ganadora = decoradas[idxMejor];
      const otras = decoradas.filter((_, i) => i !== idxMejor).sort(porPrecio);
      return [ganadora, ...otras];
    }
    return [...decoradas].sort(porPrecio);
  });

  /** Selecciona la forma de pago para el total en vivo (y prellena el dialog).
   *  A diferencia del presupuestador, no hace toggle a "Todas": el pedido
   *  siempre se cotiza con una forma concreta. */
  seleccionarForma(id: number): void {
    const f = this.formasPago().find((x) => x.id === id) ?? null;
    if (f) this.formaPagoSeleccionada.set(f);
  }

  /** Clase CSS completa de un chip de forma (color rotativo + mejor + sel). */
  clasesFormaChip(f: FormaChipEditor): string {
    const color = `color-${(f.indiceOriginal % 10) + 1}`;
    const mejor = f.esMejorPrecio ? ' kt-forma-chip-mejor' : '';
    const sel = f.id === this.formaPagoSeleccionada()?.id ? ' kt-forma-chip-seleccionado' : '';
    return `kt-forma-chip ${color}${mejor}${sel}`;
  }

  /** Ícono PrimeNG inferido del nombre de la forma de pago. */
  iconoForma(nombre: string | null | undefined): string {
    return iconoFormaReferencia(nombre);
  }

  /** Cuando el operador escribe en "Desc. global", el % se COPIA a cada ítem
   *  (sobreescribe su descuento por línea) como atajo. NO se suma sobre los
   *  descuentos individuales. El display se recalcula solo como % efectivo.
   *  Reemplaza el array (no muta in-place) para que `carrito-tabla` refleje el
   *  cambio en cada fila. */
  actualizarDescuentoGlobal(valor: number): void {
    if (!Number.isFinite(valor) || valor < 0) valor = 0;
    if (valor > 100) valor = 100;
    const items = this.items();
    if (items.length === 0) return;
    // Al enfocar/desenfocar sin tipear, p-inputNumber re-emite el % efectivo
    // mostrado; si coincide (±0,005) no hubo cambio real → no aplastar los
    // descuentos individuales distintos con el promedio.
    if (Math.abs(valor - this.descuentoGlobal()) < 0.005) return;
    if (items.every((it) => (it.descuentoPorcentaje ?? 0) === valor)) return;
    this.items.set(items.map((it) => ({ ...it, descuentoPorcentaje: valor })));
    this.itemsTick.update((v) => v + 1);
    this.hayCambiosSinGuardar.set(true);
    this.toast.add({
      severity: 'info', summary: 'Descuento global aplicado',
      detail: `${valor}% sobre ${items.length} ${items.length === 1 ? 'ítem' : 'ítems'}.`,
      life: 1500,
    });
  }

  /** Clase del input "Desc. global" — resaltado del acento cuando hay descuento. */
  claseInputDescuentoGlobal(): string {
    const base = 'text-center descuento-input';
    return this.descuentoGlobal() > 0
      ? `${base} font-semibold text-sky-600 dark:text-sky-400`
      : `${base} text-muted-color`;
  }

  /** Selecciona el contenido del input al enfocarlo (el "0%" no se concatena). */
  protected readonly seleccionarAlEnfocar = seleccionarTextoAlEnfocar;

  /** Pre-llenado del formulario de cliente del dialog con los datos ya
   *  cargados en ESTE pedido — evita que el operador tenga que retipearlos
   *  de memoria (son obligatorios) y arriesgar un dato distinto al que ya
   *  tiene DUX. `rubro` queda afuera: {@link PedidoDetalle} no lo guarda a
   *  nivel cliente; lo resuelve el autocompletado por CUIT del dialog. */
  readonly clientePrefill = computed<PedidoClientePrefill | null>(() => {
    const p = this.pedido();
    if (!p) return null;
    return {
      nombre: p.nombre ?? undefined,
      razonSocial: p.apellidoRazonSocial ?? undefined,
      telefono: p.telefono ?? undefined,
      email: p.email ?? undefined,
      nroDoc: p.nroDoc ?? undefined,
      // Forma que el operador tiene elegida en el comparativo (cae a la del
      // pedido original si todavía no resolvió ninguna).
      formaPagoId: this.formaPagoSeleccionada()?.id ?? p.formaPagoId ?? undefined,
    };
  });

  /** Ítems mapeados al shape que espera `crear-pedido-dialog` en su modo
   *  "editar pedido" (sin presupuesto detrás). */
  readonly itemsParaDialog = computed<PedidoItemEntrada[]>(() => {
    this.itemsTick();
    return this.items().map((it) => ({
      sku: it.sku,
      cantidad: it.cantidad,
      precioConIva: it.pvpKtGastroConIva,
      porcIva: it.porcIva,
      descuentoPorcentaje: it.descuentoPorcentaje ?? null,
      rubro: it.rubro ?? null,
      comentarios: it.comentarios ?? null,
    }));
  });

  constructor() {
    this.precioPerfil.cargar();

    const idParam = this.route.snapshot.paramMap.get('id');
    const id = idParam != null ? Number(idParam) : NaN;
    if (!idParam || !Number.isFinite(id) || id <= 0) {
      this.toast.add({
        severity: 'error',
        summary: 'Pedido inválido',
        detail: 'No se especificó un pedido para editar.',
        life: 6000,
      });
      this.router.navigate(['/pedidos']);
      return;
    }
    this.pedidoId.set(id);
    this.cargarPedido(id);

    // Resuelve la forma de pago inicial en cuanto el pedido Y la lista de
    // formas activas estén disponibles (pueden llegar en cualquier orden:
    // el pedido es un GET propio, las formas las carga PrecioPerfilService).
    // Solo corre una vez — `formaResuelta` evita pisar un cambio posterior
    // del operador en el selector.
    //
    // El guard y las escrituras van en untracked: las únicas dependencias son
    // `formasPago` y `pedido`. Si `formaResuelta` se leyera trackeada sería a
    // la vez dependencia y escritura del effect, que es la forma exacta del
    // loop infinito que colgaba el navegador en crear-pedido-dialog. Hoy no
    // loopea porque el guard corta en la 2ª vuelta, pero eso depende de que
    // nadie vuelva a ponerla en false: así es inmune por construcción.
    effect(() => {
      const formas = this.formasPago();
      const ped = this.pedido();
      if (!ped || formas.length === 0) return;
      untracked(() => {
        if (this.formaResuelta()) return;
        this.formaPagoSeleccionada.set(formas.find((f) => f.id === ped.formaPagoId) ?? null);
        this.formaResuelta.set(true);
      });
    });

    // Purga el map de "cambios de precio" cuando un ítem se quita del detalle,
    // así el contador del banner no queda inflado con uids que ya no existen.
    //
    // La única dependencia es `items` (es lo que gatilla la purga); el map se
    // lee dentro de untracked porque también se escribe acá — trackearlo lo
    // haría dependencia y escritura a la vez, la forma del loop infinito que
    // colgaba crear-pedido-dialog. Hoy converge porque el `some` da false tras
    // purgar, pero así no depende de esa guarda.
    effect(() => {
      const vivos = new Set(this.items().map((i) => i.uid));
      untracked(() => {
        const m = this.cambiosPrecio();
        if ([...m.keys()].some((k) => !vivos.has(k))) {
          this.cambiosPrecio.set(new Map([...m].filter(([k]) => vivos.has(k))));
        }
      });
    });

    // Observa el alto del footer sticky y lo refleja en `footerHeight()`, para
    // que el padding-bottom del main crezca cuando los chips de formas hacen
    // flex-wrap a 2+ líneas y el footer no tape los últimos ítems.
    //
    // A prueba de loops: el callback se difiere a requestAnimationFrame y solo
    // escribe la señal si el alto cambió de verdad. Así, aunque un ajuste de
    // layout dispare el observer, no se re-entra sincrónicamente ni se generan
    // ciclos de change-detection (la causa raíz —el toggle de la scrollbar— la
    // corta `scrollbar-gutter: stable` en styles.scss).
    effect((onCleanup) => {
      const el = this.footerSticky()?.nativeElement;
      if (!el || typeof window === 'undefined') return;
      let frame = 0;
      const update = () => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          const h = Math.round(el.offsetHeight);
          if (h !== this.footerHeight()) this.footerHeight.set(h);
        });
      };
      const obs = new ResizeObserver(update);
      obs.observe(el);
      update();
      onCleanup(() => {
        cancelAnimationFrame(frame);
        obs.disconnect();
      });
    });
  }

  private cargarPedido(id: number): void {
    this.cargando.set(true);
    this.api.obtenerPedido(id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (det) => {
        this.pedido.set(det);
        this.items.set(pedidoItemsAPresupuestoItems(det.items, this.backendStatus.skuProductoGenerico()));
        this.cargando.set(false);
        this.hayCambiosSinGuardar.set(false);
        this.buscador()?.focusScanInput();
        this.enriquecerYDetectarCambios(det);
      },
      error: (err) => {
        this.cargando.set(false);
        toastError(this.toast, 'Editar pedido', err,
          'No se pudo cargar el pedido. Volvé al listado e intentá de nuevo.');
        this.router.navigate(['/pedidos']);
      },
    });
  }

  /** Al abrir el pedido, hace UN lookup contra el catálogo local (cache en BD,
   *  no toca DUX) para:
   *   1. Enriquecer cada ítem con descripción/stock/imagen/habilitado actuales
   *      (el pedido guarda pocos de estos datos → sin esto la tabla mostraba
   *      "stock —" y sin foto).
   *   2. Pedidos VIEJOS (sin `precioListaConIva` guardado): recotización
   *      silenciosa al precio actual — su precio congelado era una aproximación
   *      POST-forma, no un precio de lista real (dispara {@link huboRecotizacion}).
   *   3. Pedidos con precio congelado: NO se pisa; solo se DETECTA si el
   *      catálogo cambió (→ {@link cambiosPrecio}), que alimenta el pill por
   *      fila y el banner. El operador decide traerlos con "Actualizar precios".
   *
   *  Matchea por `uid` (`${sku}-${i}`) para no depender del orden del array. */
  private enriquecerYDetectarCambios(det: PedidoDetalle): void {
    const viejos = new Set(
      det.items
        .map((it, i) => ({ uid: `${it.sku}-${i}`, viejo: it.precioListaConIva == null }))
        .filter((x) => x.viejo)
        .map((x) => x.uid),
    );
    const skus = this.items().filter((it) => !it.generico).map((it) => it.sku);
    if (skus.length === 0) return;

    this.api.lookupBulk(skus).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (frescos) => {
        const porSku = new Map(frescos.map((f) => [f.sku, f]));
        const cambios = new Map<string, CambioPrecio>();
        let recotizo = false;
        this.items.set(
          this.items().map((it) => {
            // Genéricos no se refrescan contra catálogo — su SKU es comodín.
            if (it.generico) return it;
            const f = porSku.get(it.sku);
            if (!f) return it;
            // Enriquecer datos de catálogo (no tocan el precio).
            const enriquecido: PresupuestoItem = {
              ...it,
              descripcion: f.descripcion ?? it.descripcion,
              stockTotal: f.stockTotal,
              habilitado: f.habilitado ?? it.habilitado,
              imagenUrl: f.imagenUrl ?? it.imagenUrl,
            };
            if (f.pvpKtGastroConIva == null) return enriquecido;
            if (viejos.has(it.uid)) {
              // Pedido viejo: recotización silenciosa al precio de lista actual.
              recotizo = true;
              return {
                ...enriquecido,
                pvpKtGastroConIva: f.pvpKtGastroConIva,
                pvpKtGastroSinIva: f.pvpKtGastroSinIva,
                porcIva: f.porcIva,
                rubro: f.rubro ?? it.rubro,
              };
            }
            // Precio congelado: avisamos solo si cambia el PRECIO DE REFERENCIA
            // que ve el cliente (`precioMostrado` resuelve el perfil por rubro:
            // menaje c/IVA, maquinaria s/IVA). Así un cruce de rubro menaje↔
            // maquinaria —que cambia el precio real— se detecta, y la config de
            // la forma de referencia se cancela (misma en ambos lados, no genera
            // falsos positivos). Mismo criterio que el presupuestador.
            const guardado = redondearMoneda(this.precioPerfil.precioMostrado(it));
            const actual = redondearMoneda(
              this.precioPerfil.precioMostrado({
                pvpKtGastroConIva: f.pvpKtGastroConIva,
                pvpKtGastroSinIva: f.pvpKtGastroSinIva,
                porcIva: f.porcIva,
                rubro: f.rubro ?? it.rubro,
              }),
            );
            if (guardado > 0 && guardado !== actual) {
              cambios.set(it.uid, { precioGuardado: guardado, precioActual: actual });
            }
            return enriquecido;
          }),
        );
        this.cambiosPrecio.set(cambios);
        if (recotizo) this.huboRecotizacion.set(true);
        this.itemsTick.update((v) => v + 1);
      },
      // Sin catálogo (fallo del lookup): se dejan los precios congelados sin
      // pills; el operador igual puede guardar con los datos del pedido.
      error: () => { /* best-effort: no rompe la pantalla */ },
    });
  }

  /** Trae los precios actuales del catálogo (cache local, no toca DUX) y los
   *  aplica a los ítems de catálogo conservando cantidad, descuento, uid y
   *  comentarios. Pide confirmación porque reemplaza precios que pudieron
   *  negociarse. Al terminar, limpia {@link cambiosPrecio}. Mismo flujo que el
   *  presupuestador. */
  actualizarPreciosDesdeCatalogo(): void {
    const skus = this.items().filter((it) => !it.generico).map((it) => it.sku);
    if (skus.length === 0) {
      this.toast.add({ severity: 'warn', summary: 'Sin catálogo',
        detail: 'No hay productos de catálogo para actualizar.', life: 4000 });
      return;
    }
    this.confirmationService.confirm({
      header: '¿Actualizar precios?',
      message: 'Se van a reemplazar los precios de este pedido por los del '
        + 'catálogo actual. Las cantidades y los descuentos se conservan. ¿Continuás?',
      icon: 'pi pi-dollar',
      acceptButtonProps: { label: 'Actualizar', icon: 'pi pi-refresh' },
      rejectButtonProps: { label: 'Cancelar', severity: 'secondary', outlined: true },
      accept: () => this.ejecutarActualizarPrecios(skus),
      reject: () => this.buscador()?.focusScanInput(),
    });
  }

  private ejecutarActualizarPrecios(skus: string[]): void {
    this.actualizandoPrecios.set(true);
    this.api.lookupBulk(skus).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (frescos) => {
        this.actualizandoPrecios.set(false);
        const porSku = new Map(frescos.map((f) => [f.sku, f]));
        let actualizados = 0;
        let sinCambios = 0;
        let noEncontrados = 0;
        this.items.set(
          this.items().map((it) => {
            if (it.generico) return it;
            const f = porSku.get(it.sku);
            if (!f || f.pvpKtGastroConIva == null) {
              noEncontrados++;
              return it;
            }
            const guardado = redondearMoneda(it.pvpKtGastroConIva ?? 0);
            const actual = redondearMoneda(f.pvpKtGastroConIva);
            if (guardado === actual) {
              sinCambios++;
              return it;
            }
            actualizados++;
            // Pisa SOLO precio/IVA/rubro; conserva cantidad, descuento, uid.
            return {
              ...it,
              pvpKtGastroConIva: f.pvpKtGastroConIva,
              pvpKtGastroSinIva: f.pvpKtGastroSinIva,
              porcIva: f.porcIva,
              rubro: f.rubro ?? it.rubro,
            };
          }),
        );
        this.itemsTick.update((v) => v + 1);
        if (actualizados > 0) this.hayCambiosSinGuardar.set(true);
        // Ya al día: se vacían los pills/banner de "precio desactualizado".
        this.cambiosPrecio.set(new Map());

        const partes: string[] = [
          `${actualizados} ${actualizados === 1 ? 'precio actualizado' : 'precios actualizados'}`,
        ];
        if (sinCambios > 0) partes.push(`${sinCambios} sin ${sinCambios === 1 ? 'cambio' : 'cambios'}`);
        if (noEncontrados > 0) partes.push(`${noEncontrados} fuera de catálogo`);
        this.toast.add({
          severity: actualizados > 0 ? 'success' : 'info',
          summary: actualizados > 0 ? 'Precios actualizados' : 'Sin cambios de precio',
          detail: partes.join(', ') + '.',
          life: 5000,
        });
        this.buscador()?.focusScanInput();
      },
      error: (err) => {
        this.actualizandoPrecios.set(false);
        toastError(this.toast, 'Actualizar precios', err,
          'No se pudieron actualizar los precios.');
      },
    });
  }

  /** Marca "cambios sin guardar" y replica el toast de la mutación (mismo
   *  patrón que presupuestos-page.onCarritoMutacion). */
  onCarritoMutacion(ev: CarritoMutacion): void {
    this.itemsTick.update((v) => v + 1);
    this.hayCambiosSinGuardar.set(true);
    this.toast.add({ severity: ev.severity, summary: ev.summary, detail: ev.detail, life: 1000 });
  }

  abrirGuardar(): void {
    if (this.items().length === 0) return;
    this.mostrarDialog.set(true);
  }

  /** El dialog creó el pedido nuevo (y anuló el viejo vía
   *  `regenerarPedidoDesdePedido`) — avisamos y volvemos al listado. */
  onPedidoCreado(ev: { presupuestoId: number | null; pedidoLocalId: number }): void {
    this.hayCambiosSinGuardar.set(false);
    const anteriorId = this.pedidoId();
    const idNuevo = ev.pedidoLocalId ? ` #${ev.pedidoLocalId}` : '';
    this.toast.add({
      severity: 'success',
      summary: 'Pedido actualizado',
      detail: anteriorId != null
        ? `Se creó el pedido nuevo${idNuevo}; el pedido #${anteriorId} anterior quedó anulado.`
        : `Se creó el pedido nuevo${idNuevo}.`,
      life: 8000,
    });
    this.router.navigate(['/pedidos']);
  }

  /** Implementa {@link HasUnsavedChanges} para el `unsavedChangesGuard`. */
  hasUnsavedChanges(): boolean {
    return this.hayCambiosSinGuardar();
  }
}
