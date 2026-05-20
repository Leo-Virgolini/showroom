import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { MessageService } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { DialogModule } from 'primeng/dialog';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { TableModule } from 'primeng/table';
import { TextareaModule } from 'primeng/textarea';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { ToolbarModule } from 'primeng/toolbar';
import { TooltipModule } from 'primeng/tooltip';
import {
  CatalogoItem,
  EnviarPresupuestoRequest,
  FormaPago,
  GenerarPresupuestoRequest,
  PresupuestoFormaPagoSnapshot,
  PresupuestoItem,
  ScanResult,
} from '../models';
import { ShowroomService } from '../showroom.service';
import { BackendStatusService } from '../backend-status.service';
import { toastError } from '../toast.utils';

/**
 * Pantalla para armar presupuestos comerciales: el operador escanea/busca
 * productos, define cantidad + descuento individual, y al final genera un
 * PDF con la estética KT GASTRO que se le manda al cliente por email.
 *
 * <p>El toggle "Cotización individual" controla el formato del PDF:
 *   - OFF: una hoja agregada (tabla detalle + total + formas de pago globales).
 *   - ON: una hoja por cada producto (foto + formas de pago calculadas sobre
 *     el precio de ese ítem). Útil cuando el cliente pide cotizar varias
 *     alternativas independientes (ej. amasadora 20L vs 30L).
 *
 * <p>NO toca DUX ni el carrito server-side — todo el estado vive en signals
 * locales hasta que se llama al endpoint que persiste la cabecera y emite
 * el PDF.
 */
@Component({
  selector: 'app-presupuestos-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    FormsModule,
    RouterLink,
    ButtonModule,
    CardModule,
    DialogModule,
    IconFieldModule,
    InputIconModule,
    InputNumberModule,
    InputTextModule,
    ProgressSpinnerModule,
    TableModule,
    TextareaModule,
    ToggleSwitchModule,
    ToolbarModule,
    TooltipModule,
  ],
  templateUrl: './presupuestos-page.html',
  styleUrl: './presupuestos-page.scss',
})
export class PresupuestosPage implements AfterViewInit {
  private readonly api = inject(ShowroomService);
  private readonly toast = inject(MessageService);
  private readonly backendStatus = inject(BackendStatusService);
  private readonly destroyRef = inject(DestroyRef);

  readonly scanInput = viewChild<ElementRef<HTMLInputElement>>('scanInput');

  /** Pantalla ≥ 1024px — usado para ocultar los labels de los botones del
   *  toolbar en mobile y dejar solo el ícono. Mismo patrón que showroom-page. */
  readonly screenLg = signal(
    typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches,
  );

  // ------------------------------------------------------------
  // Inputs y estado del scan
  // ------------------------------------------------------------
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
  /** Lista de ítems del presupuesto — orden de agregado preservado.
   *  Solo se reemplaza el array al AGREGAR o ELIMINAR ítems; las ediciones
   *  inline (cantidad, descuento) mutan el objeto in-place para no
   *  re-renderizar la fila completa de la tabla — sino p-inputNumber pierde
   *  el foco con cada keystroke al recibir un writeValue desde afuera. */
  readonly items = signal<PresupuestoItem[]>([]);
  /** Contador que se incrementa cuando un ítem se muta in-place (no cambia la
   *  referencia del array {@link items}). Los {@link computed} que dependen
   *  de propiedades de los ítems (totales) leen este signal para forzar el
   *  recompute sin necesidad de reemplazar el array. */
  private readonly itemsTick = signal(0);

  // ------------------------------------------------------------
  // Datos del cliente / observaciones
  // ------------------------------------------------------------
  readonly clienteNombre = signal('');
  readonly clienteTelefono = signal('');
  readonly clienteEmail = signal('');
  readonly observaciones = signal('');

  // ------------------------------------------------------------
  // Modo "Cotización individual" — toggle único. Cuando está ON, el PDF
  // emite una hoja por cada ítem con foto grande + sus propias formas de
  // pago calculadas sobre el precio de ese ítem. OFF = formato tradicional
  // (tabla detalle + total + formas globales sobre el total agregado).
  // ------------------------------------------------------------
  readonly cotizacionIndividual = signal(false);

  // ------------------------------------------------------------
  // Formas de pago activas (selector global)
  // ------------------------------------------------------------
  readonly formasPago = signal<FormaPago[]>([]);

  // ------------------------------------------------------------
  // Operaciones en curso
  // ------------------------------------------------------------
  readonly generandoPreview = signal(false);
  readonly enviandoEmail = signal(false);
  readonly mostrarDialogEnviar = signal(false);

  /** Todos los ítems entran al PDF — ya no hay checkbox por fila para
   *  excluir ítems individuales. Si el operador no quiere un ítem, lo borra. */
  readonly hayItems = computed(() => {
    this.itemsTick();
    return this.items().length > 0;
  });

  /** Subtotal BRUTO sin IVA (sin ningún descuento) — precios de lista
   *  multiplicados por cantidad. Es la base para calcular el descuento
   *  efectivo total. */
  readonly subtotalBrutoSinIva = computed(() => {
    this.itemsTick();
    return this.items().reduce((acc, it) => {
      return acc + (it.pvpKtGastroSinIva ?? 0) * it.cantidad;
    }, 0);
  });

  /** Total SIN IVA con los descuentos INDIVIDUALES aplicados — es lo que
   *  paga el cliente. No hay un "descuento global" adicional encima: el
   *  campo `descuentoGlobal` es solo un reflejo del % efectivo y, cuando
   *  el operador lo modifica, propaga ese valor a TODOS los descuentos
   *  individuales. */
  readonly totalSinIva = computed(() => {
    this.itemsTick();
    return this.items().reduce((acc, it) => {
      const precio = it.pvpKtGastroSinIva ?? 0;
      const desc = it.descuentoPorcentaje ?? 0;
      return acc + precio * (1 - desc / 100) * it.cantidad;
    }, 0);
  });

  /** Total CON IVA con descuentos individuales aplicados — base para las
   *  formas de pago que aplican IVA. */
  readonly totalConIva = computed(() => {
    this.itemsTick();
    return this.items().reduce((acc, it) => {
      const precio = it.pvpKtGastroConIva ?? 0;
      const desc = it.descuentoPorcentaje ?? 0;
      return acc + precio * (1 - desc / 100) * it.cantidad;
    }, 0);
  });

  /** Suma en pesos de los descuentos individuales (= subtotal bruto - total). */
  readonly descuentoTotalMonto = computed(() =>
    this.subtotalBrutoSinIva() - this.totalSinIva(),
  );

  /** % EFECTIVO del descuento sobre el subtotal bruto. Cuando todos los
   *  ítems llevan el mismo descuento individual coincide con ese %; cuando
   *  difieren refleja el promedio ponderado por peso de cada línea
   *  (`descTotal_$ / subtotalBruto × 100`). Se muestra en el input
   *  "Descuento global" y, si el operador lo edita, ese nuevo % se copia a
   *  cada ítem (no se "suma" encima). */
  readonly descuentoGlobal = computed(() => {
    const bruto = this.subtotalBrutoSinIva();
    if (bruto <= 0) return 0;
    return (this.descuentoTotalMonto() / bruto) * 100;
  });

  /** Snapshots de las formas de pago con el precio final ya calculado, listo
   *  para mandar al backend al generar el PDF. */
  readonly formasPagoCalculadas = computed<PresupuestoFormaPagoSnapshot[]>(() => {
    const baseConIva = this.totalConIva();
    const baseSinIva = this.totalSinIva();
    return this.formasPago().map((f) => {
      const recargo = (f.recargoPorcentaje ?? 0) / 100;
      const aplicaIva = f.aplicaIva ?? true;
      const base = aplicaIva ? baseConIva : baseSinIva;
      const precioFinal = base * (1 + recargo);
      return {
        id: f.id,
        nombre: f.nombre,
        recargoPorcentaje: f.recargoPorcentaje ?? 0,
        cantidadCuotas: f.cantidadCuotas,
        aplicaIva,
        precioFinal,
        descripcion: this.descripcionForma(f),
      };
    });
  });

  /** Índice (en {@link formasPagoCalculadas}) de la forma con menor precio
   *  final, ignorando las que están en moneda extranjera. -1 si no hay
   *  ganadora clara (lista vacía, una sola, o empate). El backend hace el
   *  mismo cálculo al generar el PDF para mantener consistencia. */
  readonly indiceMejorPrecio = computed(() => this.calcularIndiceMejorPrecio(
    this.formasPagoCalculadas()));

  /** En modo cotización individual: para cada ítem, calcula sus propias
   *  formas de pago sobre el precio del ítem (cantidad × precio × (1 - desc)).
   *  Se usa tanto en la UI (preview por producto) como en el armado del
   *  payload al backend. Devuelve un array vacío si el modo está apagado. */
  readonly formasPagoPorItem = computed<GrupoItem[]>(() => {
    this.itemsTick();
    if (!this.cotizacionIndividual()) return [];
    const formasBase = this.formasPago();
    return this.items().map((it) => {
      const pSI = it.pvpKtGastroSinIva ?? 0;
      const pCI = it.pvpKtGastroConIva ?? 0;
      const factor = 1 - (it.descuentoPorcentaje ?? 0) / 100;
      const totalSinIva = pSI * factor * it.cantidad;
      const totalConIva = pCI * factor * it.cantidad;
      const formas: PresupuestoFormaPagoSnapshot[] = formasBase.map((f) => {
        const recargo = (f.recargoPorcentaje ?? 0) / 100;
        const aplicaIva = f.aplicaIva ?? true;
        const base = aplicaIva ? totalConIva : totalSinIva;
        const precioFinal = base * (1 + recargo);
        return {
          id: f.id,
          nombre: f.nombre,
          recargoPorcentaje: f.recargoPorcentaje ?? 0,
          cantidadCuotas: f.cantidadCuotas,
          aplicaIva,
          precioFinal,
          descripcion: this.descripcionForma(f),
          itemSku: it.sku,
        };
      });
      return {
        item: it,
        totalSinIva,
        formas,
        indiceMejorPrecio: this.calcularIndiceMejorPrecio(formas),
      };
    });
  });

  private calcularIndiceMejorPrecio(formas: PresupuestoFormaPagoSnapshot[]): number {
    if (formas.length <= 1) return -1;
    let idx = -1;
    let min: number | null = null;
    formas.forEach((f, i) => {
      if (f.precioFinal == null || f.precioFinal <= 0) return;
      if (f.monedaSimbolo) return;
      if (min == null || f.precioFinal < min) { min = f.precioFinal; idx = i; }
    });
    if (idx === -1 || min == null) return -1;
    const empates = formas.filter((f) =>
      f.precioFinal === min && !f.monedaSimbolo).length;
    return empates > 1 ? -1 : idx;
  }

  ngAfterViewInit(): void {
    this.focusInput();
  }

  constructor() {
    this.api.listarFormasPagoActivas().subscribe({
      next: (formas) => this.formasPago.set(formas),
      error: () => {
        // Si falla, los snapshots quedan vacíos — el PDF se genera igual sin sección de formas.
        this.formasPago.set([]);
      },
    });

    // Toast del resultado del envío async.
    this.backendStatus.presupuestoEmailEvents$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((ev) => {
        if (ev.estado === 'SENT') {
          this.toast.add({
            severity: 'success',
            summary: 'Presupuesto enviado',
            detail: `#${ev.presupuestoId} → ${ev.email}`,
            life: 6000,
          });
        } else if (ev.estado === 'AMBIGUO') {
          this.toast.add({
            severity: 'warn',
            summary: 'Presupuesto probablemente enviado',
            detail: `#${ev.presupuestoId} → ${ev.email}: ${ev.error ?? 'Gmail tardó en confirmar.'}`,
            life: 10000,
          });
        } else {
          this.toast.add({
            severity: 'error',
            summary: 'No se pudo enviar el presupuesto',
            detail: `#${ev.presupuestoId} — ${ev.error ?? 'Error desconocido'}`,
            life: 8000,
          });
        }
      });
  }

  // ============================================================
  // Scan / búsqueda
  //
  // SIEMPRE busca en el catálogo local cacheado — nunca dispara una llamada
  // directa a DUX. /presupuestos asume catálogo sincronizado: el operador
  // arma presupuestos sobre productos KT GASTRO conocidos, no necesita la
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
  focusInput(): void {
    setTimeout(() => this.scanInput()?.nativeElement.focus(), 0);
  }

  onScanEnter(): void {
    const query = this.skuInput().trim();
    if (!query) return;
    this.skuInput.set('');
    this.resultadosBusqueda.set([]);
    const seq = ++this.scanSeq;
    this.cargandoScan.set(true);
    this.buscarEnCatalogo(query, seq);
  }

  /** Búsqueda paginada en el catálogo CACHEADO (sin tocar DUX). Si la query
   *  matchea un único producto, lo carga directo. Si no, muestra la lista. */
  private buscarEnCatalogo(query: string, seq: number): void {
    this.busquedaQuery.set(query);
    this.paginaResultados.set(0);
    this.api.buscarCatalogo(query, 0, this.BUSQUEDA_PAGE_SIZE).subscribe({
      next: (page) => {
        if (seq !== this.scanSeq) return;
        this.cargandoScan.set(false);
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
        } else if (page.items.length === 1 && page.total === 1) {
          // Único resultado en todo el catálogo — lo agregamos directo.
          this.totalResultadosBusqueda.set(1);
          this.seleccionarResultado(page.items[0].sku);
          return;
        } else {
          this.resultadosBusqueda.set(page.items);
          this.totalResultadosBusqueda.set(page.total);
        }
        this.focusInput();
      },
      error: (err) => {
        if (seq !== this.scanSeq) return;
        this.cargandoScan.set(false);
        toastError(this.toast, 'Búsqueda', err, 'No se pudo buscar.');
        this.focusInput();
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
    this.api.buscarCatalogo(this.busquedaQuery(), nextPage, this.BUSQUEDA_PAGE_SIZE)
      .subscribe({
        next: (page) => {
          if (seq !== this.scanSeq) return;
          this.cargandoMasResultados.set(false);
          this.paginaResultados.set(nextPage);
          this.resultadosBusqueda.set([...this.resultadosBusqueda(), ...page.items]);
          this.focusInput();
        },
        error: (err) => {
          if (seq !== this.scanSeq) return;
          this.cargandoMasResultados.set(false);
          this.focusInput();
          toastError(this.toast, 'Búsqueda', err, 'No se pudieron cargar más resultados.');
        },
      });
  }

  /** Cierra la lista de resultados (botón ✕) y devuelve el foco al input. */
  cerrarResultadosBusqueda(): void {
    this.resultadosBusqueda.set([]);
    this.focusInput();
  }

  /** El operador eligió un item de la lista de resultados — lo cargamos via
   *  `/scan/{sku}` para traer todos los datos (precios c/IVA + s/IVA, stock,
   *  imagen) y lo agregamos al detalle. */
  seleccionarResultado(sku: string): void {
    this.resultadosBusqueda.set([]);
    this.cargandoScan.set(true);
    const seq = ++this.scanSeq;
    this.api.scan(sku).subscribe({
      next: (res) => {
        if (seq !== this.scanSeq) return;
        this.cargandoScan.set(false);
        this.agregarItem(res);
        this.focusInput();
      },
      error: (err) => {
        if (seq !== this.scanSeq) return;
        this.cargandoScan.set(false);
        this.focusInput();
        toastError(this.toast, 'Cargar producto', err, 'No se pudo cargar el producto.');
      },
    });
  }

  private agregarItem(res: ScanResult): void {
    const actuales = this.items();
    // Si ya existe el SKU, sumarle cantidad (caso típico: re-escanear).
    const existente = actuales.find((it) => it.sku === res.sku);
    if (existente) {
      this.items.set(actuales.map((it) =>
        it.sku === res.sku ? { ...it, cantidad: it.cantidad + 1 } : it));
      return;
    }
    const uid = `${res.sku}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const nuevo: PresupuestoItem = {
      ...res,
      uid,
      cantidad: 1,
      descuentoPorcentaje: 0,
    };
    this.items.set([...actuales, nuevo]);
  }

  // ============================================================
  // Mutaciones de items
  //
  // Las ediciones inline (cantidad/descuento) MUTAN el objeto in-place y
  // disparan `itemsTick` para que los totales se recalculen sin reemplazar
  // el array. Si reemplazamos el array, p-table recrea el binding de cada
  // fila y p-inputNumber pierde el foco con cada keystroke.
  // ============================================================
  actualizarCantidad(it: PresupuestoItem, valor: number): void {
    if (!Number.isFinite(valor) || valor <= 0) valor = 1;
    it.cantidad = valor;
    this.itemsTick.update((v) => v + 1);
  }

  actualizarDescuento(it: PresupuestoItem, valor: number): void {
    if (!Number.isFinite(valor) || valor < 0) valor = 0;
    if (valor > 100) valor = 100;
    it.descuentoPorcentaje = valor;
    this.itemsTick.update((v) => v + 1);
  }

  eliminarItem(uid: string): void {
    this.items.set(this.items().filter((it) => it.uid !== uid));
  }

  vaciar(): void {
    this.items.set([]);
    this.focusInput();
  }

  // ============================================================
  // Subtotal por línea — para mostrar en la tabla. Usa el precio SIN IVA
  // (lo que el operador ve al escanear) con el descuento individual aplicado.
  // ============================================================
  totalLinea(it: PresupuestoItem): number {
    const precio = it.pvpKtGastroSinIva ?? 0;
    const desc = it.descuentoPorcentaje ?? 0;
    return precio * (1 - desc / 100) * it.cantidad;
  }

  // ============================================================
  // Generar / enviar
  // ============================================================
  /** Cuando el operador escribe en el input "Descuento global", el % se
   *  COPIA a cada ítem (sobreescribiendo su descuentoPorcentaje individual)
   *  como atajo cuando todos los ítems llevan el mismo descuento. NO se
   *  suma sobre los descuentos por línea — esa lógica vieja se descartó.
   *  El display del input se recalcula automáticamente como % efectivo. */
  actualizarDescuentoGlobal(valor: number): void {
    if (!Number.isFinite(valor) || valor < 0) valor = 0;
    if (valor > 100) valor = 100;
    for (const it of this.items()) it.descuentoPorcentaje = valor;
    this.itemsTick.update((v) => v + 1);
  }

  /** Construye el payload del backend a partir del estado actual.
   *  En modo agregado: una sola colección de formas globales (itemSku=null)
   *  calculadas sobre el total. En modo cotización individual: una colección
   *  por cada ítem (cada forma con su itemSku), cada precioFinal recalculado
   *  sobre el precio del ítem específico. */
  private armarPayload(): GenerarPresupuestoRequest {
    const individual = this.cotizacionIndividual();
    const items = this.items().map((it) => ({
      sku: it.sku,
      descripcion: it.descripcion,
      cantidad: it.cantidad,
      precioConIva: it.pvpKtGastroConIva ?? 0,
      porcIva: it.porcIva ?? 21,
      descuentoPorcentaje: it.descuentoPorcentaje ?? 0,
    }));
    // En modo individual: una colección de formas por cada ítem (con itemSku).
    // En modo agregado: una única colección de formas globales (itemSku = null).
    const formasPago: PresupuestoFormaPagoSnapshot[] = individual
      ? this.formasPagoPorItem().flatMap((g) => g.formas)
      : this.formasPagoCalculadas().map((f) => ({ ...f, itemSku: null }));
    return {
      clienteNombre: this.clienteNombre().trim() || null,
      clienteTelefono: this.clienteTelefono().trim() || null,
      clienteEmail: this.clienteEmail().trim() || null,
      observaciones: this.observaciones().trim() || null,
      descuentoGlobalPorcentaje: this.descuentoGlobal() || 0,
      cotizacionIndividual: individual,
      items,
      formasPago,
    };
  }

  previsualizar(): void {
    if (!this.hayItems()) {
      this.warn('Tenés que seleccionar al menos un producto para previsualizar.');
      return;
    }
    this.generandoPreview.set(true);
    this.api.previewPresupuestoComercial(this.armarPayload()).subscribe({
      next: (res) => {
        this.generandoPreview.set(false);
        const blob = res.body;
        if (!blob) {
          this.warn('El backend no devolvió un PDF.');
          return;
        }
        // Bajamos el PDF a disco con un nombre legible para que el operador
        // pueda mandárselo al cliente por WhatsApp/email manual. El mismo
        // blob lo abrimos en una pestaña nueva para que lo previsualice.
        const filename = this.extraerFilename(res.headers.get('Content-Disposition'));
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        // Pequeño delay antes de abrir para no chocar con la descarga en
        // algunos navegadores (Chrome bloquea el window.open inmediato si
        // se dispara junto con un download).
        setTimeout(() => window.open(url, '_blank'), 150);
        // Liberar el blob URL después de un margen para que la pestaña
        // nueva alcance a cargar el PDF — sino al cerrar/recargar este
        // componente quedaría en memoria como leak.
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
        this.toast.add({
          severity: 'success',
          summary: 'Presupuesto generado',
          detail: 'Se descargó el PDF y se abrió para previsualizar.',
          life: 4000,
        });
      },
      error: (err) => {
        this.generandoPreview.set(false);
        toastError(this.toast, 'Previsualizar', err, 'No se pudo generar el PDF.');
      },
    });
  }

  /** Extrae el filename del header `Content-Disposition`. Acepta los
   *  formatos {@code attachment; filename="x.pdf"} y {@code inline; filename=x.pdf}.
   *  Si el filename viene URL-encoded lo decodifica defensivamente
   *  (un `%` malformado tira `URIError`, en ese caso devolvemos el raw).
   *  Si no encuentra nada usable, devuelve un fallback genérico. */
  private extraerFilename(disposition: string | null): string {
    if (!disposition) return 'presupuesto.pdf';
    const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
    if (!m) return 'presupuesto.pdf';
    const raw = m[1].trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }

  abrirDialogEnviar(): void {
    if (!this.hayItems()) {
      this.warn('Tenés que seleccionar al menos un producto para enviar.');
      return;
    }
    this.mostrarDialogEnviar.set(true);
  }

  enviarPorEmail(): void {
    const email = this.clienteEmail().trim();
    if (!email) {
      this.warn('Falta el email del cliente.');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      this.warn('El email del cliente no tiene un formato válido.');
      return;
    }
    const payload: EnviarPresupuestoRequest = {
      email,
      presupuesto: this.armarPayload(),
    };
    this.enviandoEmail.set(true);
    this.api.enviarPresupuestoComercial(payload).subscribe({
      next: (res) => {
        this.enviandoEmail.set(false);
        this.mostrarDialogEnviar.set(false);
        this.toast.add({
          severity: 'info',
          summary: 'Envío encolado',
          detail: `Presupuesto #${res.presupuestoId} → ${res.email}. El toast confirmará cuando salga.`,
          life: 5000,
        });
      },
      error: (err) => {
        this.enviandoEmail.set(false);
        toastError(this.toast, 'Enviar presupuesto', err, 'No se pudo enviar el presupuesto.');
      },
    });
  }

  private warn(detail: string): void {
    this.toast.add({ severity: 'warn', summary: 'Atención', detail, life: 5000 });
  }

  // ============================================================
  // Helpers de UI
  // ============================================================

  /** Devuelve el ícono PrimeIcons más apropiado para una forma de pago,
   *  detectando por el nombre (case-insensitive, sin acentos). Si nada
   *  matchea, cae al ícono genérico de tag. */
  iconoForma(nombre: string | null | undefined): string {
    const n = (nombre ?? '').toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (n.includes('efectivo')) return 'pi pi-money-bill';
    if (n.includes('usd') || n.includes('dolar') || n.includes('dólar')) return 'pi pi-dollar';
    if (n.includes('transferencia') || n.includes('deposito') || n.includes('depósito')) return 'pi pi-arrow-right-arrow-left';
    if (n.includes('check') || n.includes('cheque')) return 'pi pi-receipt';
    if (n.includes('mercadopago') || n.includes('mercado pago')) return 'pi pi-shopping-cart';
    if (n.includes('cuota')) return 'pi pi-calendar';
    if (n.includes('tarjeta') || n.includes('debito') || n.includes('débito') || n.includes('credito') || n.includes('crédito')) return 'pi pi-credit-card';
    if (n.includes('remito')) return 'pi pi-file';
    return 'pi pi-tag';
  }

  /** Descripción comercial de la forma de pago que se muestra en la card del
   *  cliente (PDF + frontend). NO incluye "X% de recargo" — ese % está
   *  configurado en el sistema sobre el precio CON IVA u s/IVA según la forma,
   *  no contra el "Mejor precio". Mostrárselo al cliente confunde: ve "10%
   *  de recargo" cuando en realidad la diferencia vs efectivo es ~33%.
   *
   *  Sí mantenemos "X% de descuento" cuando aplica — los descuentos suelen
   *  ser chicos y se entienden directamente, y son información valiosa
   *  ("esta forma te da un 5% off"). */
  private descripcionForma(f: FormaPago): string {
    const partes: string[] = [];
    if ((f.recargoPorcentaje ?? 0) < 0) {
      partes.push(`${Math.abs(f.recargoPorcentaje)}% de descuento`);
    }
    if ((f.cantidadCuotas ?? 1) > 1) {
      partes.push(`${f.cantidadCuotas} cuotas`);
    }
    if (f.aplicaIva === false) {
      partes.push('s/IVA');
    }
    return partes.join(' · ');
  }
}

/** En modo cotización individual: un ítem + sus formas de pago calculadas
 *  sobre el precio del ítem. Solo se construye en
 *  {@link PresupuestosPage.formasPagoPorItem}; el backend recibe items y
 *  formas planos (cada forma con su `itemSku`) y reagrupa por su cuenta. */
interface GrupoItem {
  item: PresupuestoItem;
  /** Total s/IVA del ítem (precio × cantidad × (1 - descuento)). */
  totalSinIva: number;
  formas: PresupuestoFormaPagoSnapshot[];
  indiceMejorPrecio: number;
}
