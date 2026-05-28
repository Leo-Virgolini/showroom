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
import { ActivatedRoute, RouterLink } from '@angular/router';
import { ConfirmationService, MessageService } from 'primeng/api';
import { AutoCompleteCompleteEvent, AutoCompleteModule } from 'primeng/autocomplete';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { DialogModule } from 'primeng/dialog';
import { IconFieldModule } from 'primeng/iconfield';
import { ImageModule } from 'primeng/image';
import { InputIconModule } from 'primeng/inputicon';
import { InputMaskModule } from 'primeng/inputmask';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { SelectModule } from 'primeng/select';
import { TableModule } from 'primeng/table';
import { TextareaModule } from 'primeng/textarea';
import { SelectButtonModule } from 'primeng/selectbutton';
import { ToolbarModule } from 'primeng/toolbar';
import { TooltipModule } from 'primeng/tooltip';
import {
  CatalogoItem,
  EnviarPresupuestoRequest,
  FormaPago,
  GenerarPresupuestoRequest,
  PresupuestoDetalle,
  PresupuestoFormaPagoSnapshot,
  PresupuestoItem,
  ScanResult,
} from '../models';
import { ShowroomService } from '../showroom.service';
import { BackendStatusService } from '../backend-status.service';
import { MoreMenu } from '../more-menu/more-menu';
import { toastError } from '../toast.utils';
import { UserChip } from '../user-chip/user-chip';

/** Redondeo HALF_UP a 2 decimales para que el preview en pantalla coincida
 *  con el `BigDecimal.setScale(2, HALF_UP)` que aplica el backend al generar
 *  el PDF. Evita discrepancias de centavos en formas de pago con muchos
 *  decimales (ej. 99.99 × 1.15 = 114.9885). */
const redondearMoneda = (n: number): number => Math.round(n * 100) / 100;

/** Dominios sugeridos al tipear el email — mismo set que el dialog de pedidos
 *  para mantener consistencia visual y de comportamiento entre ambos flujos. */
const DOMINIOS_EMAIL_SUGERIDOS = [
  'gmail.com',
  'hotmail.com',
  'outlook.com',
  'yahoo.com.ar',
  'live.com',
  'icloud.com',
];

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
    AutoCompleteModule,
    ButtonModule,
    CardModule,
    DialogModule,
    IconFieldModule,
    ImageModule,
    InputIconModule,
    InputMaskModule,
    InputNumberModule,
    InputTextModule,
    ProgressSpinnerModule,
    SelectModule,
    TableModule,
    TextareaModule,
    SelectButtonModule,
    ToolbarModule,
    TooltipModule,
    MoreMenu,
    UserChip,
  ],
  templateUrl: './presupuestos-page.html',
  styleUrl: './presupuestos-page.scss',
})
export class PresupuestosPage implements AfterViewInit {
  private readonly api = inject(ShowroomService);
  private readonly toast = inject(MessageService);
  private readonly confirmationService = inject(ConfirmationService);
  private readonly backendStatus = inject(BackendStatusService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly route = inject(ActivatedRoute);

  /** Si está en una URL `/presupuestos/editar/:id`, el id se setea acá y la
   *  pantalla pasa a modo edición: el botón principal dice "Guardar cambios",
   *  el confirm dialog cambia de copy, y `previsualizar()` llama al PUT en
   *  lugar del POST de creación. Null = modo creación (URL `/presupuestos`). */
  readonly presupuestoEditandoId = signal<number | null>(null);
  /** True mientras se carga el detalle del presupuesto a editar — pinta un
   *  overlay simple para que el operador no toque el form a medio llenar. */
  readonly cargandoEdicion = signal(false);

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
  /** Lista dinámica de sugerencias del autocomplete del email — se rearma
   *  con cada keystroke (ver {@link onCompletarEmail}). */
  readonly sugerenciasEmail = signal<string[]>([]);
  /** Rubro del cliente — uno de los predefinidos en {@link RUBROS_PREDEFINIDOS}
   *  o `'otros'` para activar el input libre {@link rubroOtros}. Null/vacío =
   *  no completado. */
  readonly rubro = signal<string | null>(null);
  /** Texto libre cuando el operador eligió "Otros" en el dropdown de rubro.
   *  Solo se manda al backend si {@link rubro} === 'otros'. */
  readonly rubroOtros = signal('');
  readonly observaciones = signal('');

  /** Opciones del dropdown de rubro. La opción 'otros' habilita un input
   *  libre para tipear el rubro a medida. */
  readonly opcionesRubro: { label: string; value: string }[] = [
    { label: 'Bar', value: 'bar' },
    { label: 'Restaurant', value: 'restaurant' },
    { label: 'Catering', value: 'catering' },
    { label: 'Cafetería', value: 'cafeteria' },
    { label: 'Panadería', value: 'panaderia' },
    { label: 'Pastelería', value: 'pasteleria' },
    { label: 'Otros…', value: 'otros' },
  ];

  // ------------------------------------------------------------
  // Modo "Cotización individual" — toggle único. Cuando está ON, el PDF
  // emite una hoja por cada ítem con foto grande + sus propias formas de
  // pago calculadas sobre el precio de ese ítem. OFF = formato tradicional
  // (tabla detalle + total + formas globales sobre el total agregado).
  // ------------------------------------------------------------
  readonly cotizacionIndividual = signal(false);

  /** Opciones del selector "Modo de cotización" — controla el formato del
   *  PDF. {@code agregado} = tabla detalle + total + formas globales; en
   *  {@code individual} = 1 hoja por producto con sus propias formas. */
  readonly modoCotizacionOpciones = [
    { label: 'Agregado', value: 'agregado', icon: 'pi pi-list' },
    { label: 'Individual', value: 'individual', icon: 'pi pi-file-export' },
  ];

  /** Value bindeable al p-selectButton — string en lugar del boolean
   *  interno de `cotizacionIndividual` para que las opciones sean
   *  semánticas y no "true/false". */
  modoCotizacionValue(): 'agregado' | 'individual' {
    return this.cotizacionIndividual() ? 'individual' : 'agregado';
  }

  setModoCotizacion(value: 'agregado' | 'individual' | null): void {
    // El selectButton no permite deselección porque le seteamos
    // [allowEmpty]="false", pero defensive si llega null lo dejamos en agregado.
    this.cotizacionIndividual.set(value === 'individual');
  }

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
   *  para mandar al backend al generar el PDF.
   *
   *  El "recargo %" se interpreta como **descuento por pago contado**, no
   *  como sobrecargo aditivo: el efectivo es un X% menos que el precio en
   *  esa forma, así que el precio = `efectivo / (1 - X/100)`. Para 12 cuotas
   *  al 28%, el factor real es 1/0,72 ≈ 1,389 (no 1,28). */
  readonly formasPagoCalculadas = computed<PresupuestoFormaPagoSnapshot[]>(() => {
    const baseConIva = this.totalConIva();
    const baseSinIva = this.totalSinIva();
    return this.formasPago().map((f) => {
      const recargo = (f.recargoPorcentaje ?? 0) / 100;
      const aplicaIva = f.aplicaIva ?? true;
      const base = aplicaIva ? baseConIva : baseSinIva;
      const precioFinal = redondearMoneda(base / (1 - recargo));
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
        const precioFinal = redondearMoneda(base / (1 - recargo));
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

    // Si la URL trae `:id` (`/presupuestos/editar/:id`), entramos en modo
    // edición: cargamos el detalle del presupuesto y poblamos el form.
    const idParam = this.route.snapshot.paramMap.get('id');
    if (idParam) {
      const id = Number(idParam);
      if (Number.isFinite(id) && id > 0) {
        this.cargarParaEditar(id);
      }
    }

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

    // Refocus al scan input cuando el operador descarta un toast (click en
    // la X). Mismo patrón que showroom-page: sin esto, el foco queda en el
    // botón del toast y la pistola QR no escanea hasta clickear el input.
    // Solo en desktop (pointer fino) — en tablets el auto-refocus abriría
    // el teclado virtual con cada toque.
    if (typeof window === 'undefined') return;
    if (window.matchMedia('(pointer: coarse)').matches) return;
    const refocusToast = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('.p-toast')) {
        this.focusInput();
      }
    };
    document.addEventListener('click', refocusToast);
    this.destroyRef.onDestroy(() => document.removeEventListener('click', refocusToast));
  }

  /** Carga el detalle de un presupuesto guardado y popula todas las signals
   *  del formulario. Marca la pantalla en modo edición — el botón principal
   *  pasa a "Guardar cambios" y `previsualizar()` llama al PUT.
   *
   *  <p>Para los items necesitamos el shape de {@link PresupuestoItem} (extiende
   *  {@link ScanResult}); los datos serializados en BD solo traen el subset que
   *  manda el formulario al crear (sku, descripcion, cantidad, precioConIva,
   *  porcIva, descuentoPorcentaje), entonces hacemos un {@code refreshStock}
   *  para reconstruir los campos faltantes (precio s/IVA fresh, stock, imagen,
   *  habilitado). Si un SKU ya no existe en el catálogo, igual lo mostramos con
   *  los datos persistidos para que el operador pueda quitarlo o ajustarlo. */
  private cargarParaEditar(id: number): void {
    this.cargandoEdicion.set(true);
    this.api.obtenerDetallePresupuestoComercial(id).subscribe({
      next: (det) => {
        this.presupuestoEditandoId.set(det.id);
        this.clienteNombre.set(det.clienteNombre ?? '');
        this.clienteTelefono.set(det.clienteTelefono ?? '');
        this.clienteEmail.set(det.clienteEmail ?? '');
        this.observaciones.set(det.observaciones ?? '');
        // Rubro: si matchea una opción predefinida, la usamos; sino "otros" +
        // texto libre con el valor persistido.
        const rubroGuardado = det.rubro ?? null;
        if (!rubroGuardado) {
          this.rubro.set(null);
          this.rubroOtros.set('');
        } else if (this.opcionesRubro.some((o) => o.value === rubroGuardado)) {
          this.rubro.set(rubroGuardado);
          this.rubroOtros.set('');
        } else {
          this.rubro.set('otros');
          this.rubroOtros.set(rubroGuardado);
        }
        this.cotizacionIndividual.set(Boolean(det.cotizacionIndividual));

        const skus = det.items.map((it) => it.sku);
        const baseItems: PresupuestoItem[] = det.items.map((it, idx) => ({
          sku: it.sku,
          descripcion: it.descripcion,
          // El JSON persistido solo trae con-IVA. Calculamos s/IVA con el
          // porcIva guardado para tener un fallback decente mientras llega el
          // refresh; los precios reales pueden haber cambiado en DUX desde el
          // momento original — el refresh los pisa con datos actuales.
          pvpKtGastroConIva: it.precioConIva,
          pvpKtGastroSinIva: it.porcIva != null
            ? it.precioConIva / (1 + it.porcIva / 100)
            : it.precioConIva,
          porcIva: it.porcIva,
          stockTotal: null,
          habilitado: null,
          imagenUrl: null,
          sincronizadoAt: null,
          uid: `${it.sku}-edit-${idx}`,
          cantidad: it.cantidad,
          descuentoPorcentaje: it.descuentoPorcentaje ?? 0,
        }));
        this.items.set(baseItems);
        this.cargandoEdicion.set(false);
        this.focusInput();

        // Lookup contra el cache local (no toca DUX) para traer imagen,
        // stock, descripción y flag habilitado. Antes usábamos `refreshStock`
        // pero eso pega a DUX por cada item, es lento y en producción el
        // rate-limit suele tirar errores parciales — el operador veía los
        // items sin imagen y "stock no sincronizado" aunque los productos
        // sí estaban en el catálogo. El lookupBulk es instantáneo y no
        // falla por DUX. Los precios con/sin IVA y porcIva los dejamos del
        // JSON persistido — son los del momento del presupuesto y NO
        // queremos pisarlos con precios actualizados (sino editar un
        // presupuesto viejo cambiaría los precios al guardar).
        if (skus.length > 0) {
          this.api.lookupBulk(skus).subscribe({
            next: (frescos) => {
              const porSku = new Map(frescos.map((f) => [f.sku, f]));
              this.items.set(
                this.items().map((it) => {
                  const f = porSku.get(it.sku);
                  if (!f) return it;
                  return {
                    ...it,
                    descripcion: f.descripcion ?? it.descripcion,
                    stockTotal: f.stockTotal,
                    habilitado: f.habilitado,
                    imagenUrl: f.imagenUrl,
                    // Sincronizado: usamos el momento actual del lookup
                    // como indicador de "datos del catálogo cargados", aunque
                    // técnicamente el cache puede ser viejo. El operador
                    // refresca el catálogo desde /showroom si lo necesita.
                    sincronizadoAt: new Date().toISOString(),
                  };
                }),
              );
              this.itemsTick.update((v) => v + 1);
            },
            error: (err) => console.warn('[editar] lookup falló:', err),
          });
        }
      },
      error: (err) => {
        this.cargandoEdicion.set(false);
        toastError(this.toast, 'Editar', err,
          'No se pudo cargar el presupuesto. Volvé al historial e intentá de nuevo.');
      },
    });
  }

  /** True cuando la pantalla está editando un presupuesto existente. */
  readonly esModoEdicion = computed(() => this.presupuestoEditandoId() != null);

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
    // Reset de cantidades tipeadas — corresponden a la búsqueda anterior y
    // no deberían sobrevivir a una nueva query.
    this.cantidadesResultados.set({});
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

  /** Cierra la lista de resultados (botón ✕) y devuelve el foco al input.
   *  Limpia también las cantidades tipeadas — si el operador busca otra cosa
   *  después, los inputs arrancan en el default sin sorpresas heredadas. */
  cerrarResultadosBusqueda(): void {
    this.resultadosBusqueda.set([]);
    this.cantidadesResultados.set({});
    this.focusInput();
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

  /** Cantidades tipeadas en los inputs de la lista de resultados, por SKU.
   *  Vive aparte del array `resultadosBusqueda()` para no mutar el `CatalogoItem`
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

  /** Tope de cantidad para el input de la lista de resultados: stock
   *  disponible cuando está sincronizado y es > 0. Null cuando no se conoce
   *  el stock (no sincronizado) o cuando no hay — esos casos quedan sin
   *  tope; el operador ve la cantidad como pill amarillo "excede stock" en
   *  la tabla del detalle si pasa el límite. */
  cantidadMaximaResultado(r: CatalogoItem): number | null {
    return r.stockTotal != null && r.stockTotal > 0 ? r.stockTotal : null;
  }

  agregarResultado(sku: string): void {
    const cant = this.cantidadResultado(sku);
    this.seleccionarResultado(sku, cant);
  }

  private agregarItem(res: ScanResult, cantidad: number = 1): void {
    const cant = cantidad > 0 ? cantidad : 1;
    const actuales = this.items();
    // Si ya existe el SKU, sumarle cantidad (caso típico: re-escanear).
    const existente = actuales.find((it) => it.sku === res.sku);
    if (existente) {
      this.items.set(actuales.map((it) =>
        it.sku === res.sku ? { ...it, cantidad: it.cantidad + cant } : it));
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
    const tope = this.cantidadMaximaDe(it);
    if (tope != null && valor > tope) valor = tope;
    it.cantidad = valor;
    this.itemsTick.update((v) => v + 1);
  }

  /** Tope de cantidad para el input: el stock disponible cuando está
   *  sincronizado con DUX (> 0). Si el stock es null (no sincronizado) o 0
   *  (sin stock) devolvemos null para no aplicar tope — el operador puede
   *  cargar la cantidad que quiera y un pill amarillo le avisa que excede
   *  el disponible. */
  cantidadMaximaDe(it: PresupuestoItem): number | null {
    return it.stockTotal != null && it.stockTotal > 0 ? it.stockTotal : null;
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
      rubro: this.rubroFinal(),
      observaciones: this.observaciones().trim() || null,
      descuentoGlobalPorcentaje: this.descuentoGlobal() || 0,
      cotizacionIndividual: individual,
      items,
      formasPago,
    };
  }

  /** Resuelve el valor final del rubro: si el operador eligió "otros" se usa
   *  el texto libre, sino se manda la opción predefinida. Null si no completó. */
  private rubroFinal(): string | null {
    const r = this.rubro();
    if (!r) return null;
    if (r === 'otros') {
      const libre = this.rubroOtros().trim();
      return libre || null;
    }
    return r;
  }

  previsualizar(): void {
    if (!this.hayItems()) {
      this.warn('Tenés que seleccionar al menos un producto para previsualizar.');
      return;
    }
    if (!this.validarDatosCliente()) return;
    // Confirmación previa: el endpoint backend persiste el presupuesto
    // (consume número + crea/actualiza cliente). El operador tiene que saber
    // que cada click genera un registro nuevo — antes esto ocurría silencioso
    // y se ensuciaba el historial con duplicados al re-descargar para probar
    // ajustes de descuento o forma de pago.
    const nombre = this.clienteNombre().trim();
    const sujeto = nombre ? `"${nombre}"` : 'el cliente';
    const cantidad = this.items().length;
    const editandoId = this.presupuestoEditandoId();
    const header = editandoId != null ? 'Guardar cambios' : 'Generar presupuesto';
    const message = editandoId != null
      ? `Se van a guardar los cambios del presupuesto #${editandoId} ` +
        `(${cantidad} producto${cantidad === 1 ? '' : 's'}, ${sujeto}) y se descargará el PDF actualizado.\n\n` +
        `El número de presupuesto y la fecha original se mantienen.`
      : `Se va a generar el PDF con ${cantidad} producto${cantidad === 1 ? '' : 's'} ` +
        `para ${sujeto} y quedará registrado en el historial de presupuestos. ` +
        `${nombre ? sujeto : 'El cliente'} también aparecerá en la lista de Clientes.\n\n` +
        `¿Continuar?`;
    this.confirmationService.confirm({
      header,
      message,
      icon: editandoId != null ? 'pi pi-save' : 'pi pi-file-pdf',
      acceptButtonProps: {
        label: editandoId != null ? 'Guardar cambios' : 'Generar y descargar',
        icon: editandoId != null ? 'pi pi-save' : 'pi pi-download',
      },
      rejectButtonProps: {
        label: 'Cancelar',
        severity: 'secondary',
        outlined: true,
      },
      accept: () => this.ejecutarPrevisualizar(),
    });
  }

  private ejecutarPrevisualizar(): void {
    // Truco anti-popup-blocker: abrimos la pestaña en blanco AHORA, sincrónico
    // con el click del operador (sobre el botón "Generar y descargar" del
    // confirm). Chrome considera esta apertura como user-initiated (no la
    // bloquea). Cuando llega el PDF del backend, le cargamos la URL del blob
    // a esta misma pestaña.
    //
    // Si abrieramos window.open() recién en el .subscribe(next), Chrome
    // lo trata como popup automático post-async y lo bloquea.
    const previewTab = window.open('about:blank', '_blank');
    this.generandoPreview.set(true);
    const editandoId = this.presupuestoEditandoId();
    const request$ = editandoId != null
      ? this.api.actualizarPresupuestoComercial(editandoId, this.armarPayload())
      : this.api.previewPresupuestoComercial(this.armarPayload());
    request$.subscribe({
      next: (res) => {
        this.generandoPreview.set(false);
        const blob = res.body;
        if (!blob) {
          if (previewTab) previewTab.close();
          this.warn('El backend no devolvió un PDF.');
          return;
        }
        // Bajamos el PDF a disco con un nombre legible para que el operador
        // pueda mandárselo al cliente por WhatsApp/email manual. El mismo
        // blob lo abrimos en la pestaña pre-abierta para previsualizar.
        const filename = this.extraerFilename(res.headers.get('Content-Disposition'));
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
          summary: editandoId != null ? 'Cambios guardados' : 'Presupuesto generado',
          detail: editandoId != null
            ? `Presupuesto #${editandoId} actualizado y PDF descargado.`
            : 'Se descargó el PDF y se abrió para previsualizar.',
          life: 4000,
        });
      },
      error: (err) => {
        if (previewTab) previewTab.close();
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
    if (!this.validarDatosCliente()) return;
    if (!this.validarEmailParaEnvio()) return;
    this.mostrarDialogEnviar.set(true);
  }

  enviarPorEmail(): void {
    if (!this.validarDatosCliente()) return;
    if (!this.validarEmailParaEnvio()) return;
    const email = this.clienteEmail().trim();
    const payload: EnviarPresupuestoRequest = {
      email,
      presupuesto: this.armarPayload(),
    };
    this.enviandoEmail.set(true);
    const editandoId = this.presupuestoEditandoId();
    const request$ = editandoId != null
      ? this.api.actualizarYEnviarPresupuestoComercial(editandoId, payload)
      : this.api.enviarPresupuestoComercial(payload);
    request$.subscribe({
      next: (res) => {
        this.enviandoEmail.set(false);
        this.mostrarDialogEnviar.set(false);
        this.toast.add({
          severity: 'info',
          summary: editandoId != null ? 'Cambios guardados — envío encolado' : 'Envío encolado',
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

  /** Arma las sugerencias del autocomplete del email mientras el operador
   *  tipea. Replica la misma lógica del dialog de pedidos: si todavía no
   *  hay `@`, sugiere todos los dominios; si ya está el `@` con dominio
   *  parcial, filtra por prefijo. */
  onCompletarEmail(event: AutoCompleteCompleteEvent): void {
    const query = (event.query ?? '').trim();
    if (!query) {
      this.sugerenciasEmail.set([]);
      return;
    }
    const at = query.indexOf('@');
    if (at < 0) {
      this.sugerenciasEmail.set(DOMINIOS_EMAIL_SUGERIDOS.map((d) => `${query}@${d}`));
      return;
    }
    const localPart = query.substring(0, at);
    const dominioPart = query.substring(at + 1).toLowerCase();
    if (!localPart) {
      this.sugerenciasEmail.set([]);
      return;
    }
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

  /** Valida los datos del cliente. El email NO es obligatorio para previsualizar
   *  o descargar el PDF (el operador puede armar el presupuesto sin tener el
   *  email del cliente todavía). Sí lo es para enviarlo por email — esa
   *  validación se hace por separado en {@link validarEmailParaEnvio}.
   *
   *  <p>Si el operador cargó un email, lo validamos por formato igual — un
   *  email malformado guardado en BD complica el follow-up posterior.
   *  El teléfono sigue obligatorio (se usa para identificar al cliente en
   *  el seguimiento comercial). */
  private validarDatosCliente(): boolean {
    const email = this.clienteEmail().trim();
    const telefono = this.clienteTelefono().trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      this.warn('El email del cliente no tiene un formato válido.');
      return false;
    }
    if (!telefono) {
      this.warn('Falta el teléfono del cliente.');
      return false;
    }
    return true;
  }

  /** Validación adicional para los flujos que requieren enviar email
   *  (botón "Enviar por email" → dialog + POST al backend). Si el email
   *  está vacío o malformado, el envío no puede ocurrir. */
  private validarEmailParaEnvio(): boolean {
    const email = this.clienteEmail().trim();
    if (!email) {
      this.warn('Falta el email del cliente.');
      return false;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      this.warn('El email del cliente no tiene un formato válido.');
      return false;
    }
    return true;
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
    // El indicador de IVA (c/IVA / s/IVA) se renderiza aparte en el PDF y en
    // las cards del frontend, basado en `aplicaIva` del snapshot. No lo
    // agregamos a la descripción para evitar duplicación visual.
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
