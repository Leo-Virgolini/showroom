import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { MessageService } from 'primeng/api';
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
import {
  calcularIndiceMejorPrecio,
  precioPorForma,
  redondearMoneda,
} from '../precio-referencia.util';
import { PrecioPerfilService } from '../precio-perfil.service';
import { ShowroomService } from '../showroom.service';
import { BackendStatusService } from '../backend-status.service';
import { CrearPedidoDialog } from '../crear-pedido-dialog/crear-pedido-dialog';
import {
  ProductoGenericoData,
  ProductoGenericoDialog,
} from '../producto-generico-dialog/producto-generico-dialog';
import { abrirPdfEnPreview } from '../download.utils';
import { calcularSugerenciasEmail } from '../email-suggestions.utils';
import { toastError } from '../toast.utils';
import { TopActions } from '../top-actions/top-actions';
import { HasUnsavedChanges } from './unsaved-changes.guard';

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
    CrearPedidoDialog,
    ProductoGenericoDialog,
    TopActions,
  ],
  templateUrl: './presupuestos-page.html',
  styleUrl: './presupuestos-page.scss',
})
export class PresupuestosPage implements AfterViewInit, HasUnsavedChanges {
  private readonly api = inject(ShowroomService);
  private readonly toast = inject(MessageService);
  private readonly backendStatus = inject(BackendStatusService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly route = inject(ActivatedRoute);
  private readonly precioPerfil = inject(PrecioPerfilService);

  /** Si está en una URL `/presupuestos/editar/:id`, el id se setea acá y la
   *  pantalla pasa a modo edición: el botón principal dice "Guardar cambios",
   *  el confirm dialog cambia de copy, y `previsualizar()` llama al PUT en
   *  lugar del POST de creación. Null = modo creación (URL `/presupuestos`). */
  readonly presupuestoEditandoId = signal<number | null>(null);
  /** True mientras se carga el detalle del presupuesto a editar — pinta un
   *  overlay simple para que el operador no toque el form a medio llenar. */
  readonly cargandoEdicion = signal(false);
  /** True cuando hubo cambios en el detalle (agregar/modificar/quitar ítems
   *  o aplicar descuento global) desde el último guardado. En modo edición se
   *  pinta un badge "Sin guardar" cerca del botón "Guardar cambios" para que
   *  el operador no se olvide de persistir antes de salir. Se resetea al
   *  guardar/generar con éxito y al cargar inicial el detalle en edición. */
  readonly hayCambiosSinGuardar = signal(false);

  readonly scanInput = viewChild<ElementRef<HTMLInputElement>>('scanInput');
  /** Referencia al footer sticky para medir su alto real (cambia cuando los
   *  chips de formas de pago se wrappean a 2+ líneas). El padding-bottom
   *  del main se ajusta a este alto para que los últimos ítems del detalle
   *  no queden tapados. */
  readonly footerSticky = viewChild<ElementRef<HTMLElement>>('footerSticky');
  /** Alto del footer sticky en px — actualizado por ResizeObserver en el
   *  constructor. El valor inicial (96) cubre el caso típico hasta que el
   *  observador mida el alto real al primer render. */
  readonly footerHeight = signal(96);

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
  readonly formasPago = this.precioPerfil.formasPago;

  /** Forma de pago PRIMARIA = la primera de las activas que son precio de
   *  referencia (`precioReferencia === true`), ordenadas por `orden` asc.
   *  Es la forma "Efectivo" en la tabla típica. El precio mostrado por
   *  producto y los totales del presupuesto se calculan con esta forma para
   *  coincidir con el scan/visor del showroom. Null si ninguna forma activa
   *  es de referencia (entonces se cae al precio de lista según rubro). */
  /** Forma destacada/default para el perfil del producto: de las formas marcadas
   *  como referencia de ese perfil (menaje → `precioReferencia`; maquinaria →
   *  `precioReferenciaMaquinaria`), la de menor `orden`. Null si ninguna marcada
   *  (entonces se cae al precio de lista según rubro). */
  formaDestacada(esMaquinaria: boolean): FormaPago | null {
    return this.precioPerfil.formaDestacada(esMaquinaria);
  }

  /** True si el rubro cotiza sin IVA (su precio base es el PVP sin IVA y queda
   *  fuera del descuento por escala). Copiado de showroom-page. */
  rubroCotizaSinIva(rubro: string | null | undefined): boolean {
    return this.precioPerfil.rubroCotizaSinIva(rubro);
  }

  /** Recargo + aplicaIva del perfil (Normal o Maquinaria) de una forma según el
   *  rubro del ítem. Maquinaria: recargo null → 0 (no hereda del normal);
   *  aplicaIva null → false. Misma lógica que showroom-page.perfilForma. */
  perfilForma(
    forma: FormaPago,
    esMaquinaria: boolean,
  ): { recargoPorcentaje: number | null; aplicaIva: boolean | null } {
    return this.precioPerfil.perfilForma(forma, esMaquinaria);
  }

  // ------------------------------------------------------------
  // Operaciones en curso
  // ------------------------------------------------------------
  readonly generandoPreview = signal(false);
  readonly enviandoEmail = signal(false);
  /** Dialog unificado de "Datos del cliente + confirmación". Se abre antes
   *  de generar el PDF / guardar cambios / enviar por email para que el
   *  operador cargue (o revise) los datos del cliente sin que el formulario
   *  compita por espacio con el armado del presupuesto. Reemplaza la card
   *  "Datos del cliente" antes embebida en la columna derecha. */
  readonly mostrarDialogCliente = signal(false);
  /** Acción que va a ejecutar el dialog al confirmar:
   *   - `'previsualizar'` → generar PDF y descargar (POST/PUT)
   *   - `'enviar'`        → encolar envío por email
   *   - `null`            → solo edición libre (botón "Cerrar", sin acción)
   *  Se setea cuando el operador toca el botón correspondiente del toolbar. */
  readonly accionPendienteDialog = signal<'previsualizar' | 'enviar' | null>(null);

  /** Estado del dialog reusable de "Crear pedido en DUX" — solo visible
   *  en modo edición. La lógica vive en {@link CrearPedidoDialog}; este
   *  componente solo mantiene la visibilidad. */
  readonly mostrarDialogCrearPedido = signal(false);

  /** Estado del dialog de "+ Producto genérico" — para cargar líneas que no
   *  están en el catálogo (SKU comodín de DUX). El SKU concreto lo expone el
   *  backend en /health (ver {@link BackendStatusService.skuProductoGenerico}).
   *  Si está null, el botón en la UI queda oculto. */
  readonly mostrarDialogGenerico = signal(false);
  /** SKU comodín derivado del estado del backend. El template lo usa para
   *  mostrar/ocultar el botón "+ Producto genérico". */
  readonly skuGenerico = this.backendStatus.skuProductoGenerico;

  /** Id del pedido DUX al que se convirtió este presupuesto durante la
   *  sesión actual. Se setea cuando {@link CrearPedidoDialog} emite
   *  {@code pedidoCreado}; el botón "Crear pedido" se deshabilita y aparece
   *  un pill "→ Pedido #N" en su lugar para evitar duplicar la conversión.
   *  No se hidrata en {@link cargarParaEditar} porque el detalle del backend
   *  todavía no expone el flag — el control "no duplicar" para presupuestos
   *  ya convertidos antes de esta sesión vive en /historial. */
  readonly pedidoIdConvertido = signal<number | null>(null);

  /** Footer sticky con TOTAL + formas de pago. Compacto por default (chips
   *  de TODAS las formas con su precio en 1 línea, con flex-wrap a 2 líneas
   *  si no entran); cuando el operador toca el chevron se expande hacia
   *  arriba mostrando las cards completas con barras de color, descripción
   *  detallada y desglose por cuotas. En modo individual el panel expandido
   *  muestra el preview por producto en lugar de la lista global. */
  readonly footerExpandido = signal(false);

  /** Todos los ítems entran al PDF — ya no hay checkbox por fila para
   *  excluir ítems individuales. Si el operador no quiere un ítem, lo borra. */
  readonly hayItems = computed(() => {
    this.itemsTick();
    return this.items().length > 0;
  });

  /** Subtotal BRUTO EFECTIVO (sin ningún descuento) — precio efectivo unitario
   *  (forma primaria, según rubro) por cantidad. Es la base para calcular el
   *  descuento efectivo total. */
  readonly subtotalReferencia = computed(() => {
    this.itemsTick();
    return this.items().reduce((acc, it) => {
      return acc + this.precioMostrado(it) * it.cantidad;
    }, 0);
  });

  /** Total EFECTIVO con los descuentos INDIVIDUALES aplicados — es lo que
   *  paga el cliente con la forma Efectivo. No hay un "descuento global"
   *  adicional encima: el campo `descuentoGlobal` es solo un reflejo del %
   *  efectivo y, cuando el operador lo modifica, propaga ese valor a TODOS
   *  los descuentos individuales. */
  readonly totalReferencia = computed(() => {
    this.itemsTick();
    return this.items().reduce((acc, it) => {
      const precio = this.precioMostrado(it);
      const desc = it.descuentoPorcentaje ?? 0;
      return acc + precio * (1 - desc / 100) * it.cantidad;
    }, 0);
  });

  /** Suma en pesos de los descuentos individuales (= subtotal bruto - total). */
  readonly descuentoTotalMonto = computed(() =>
    this.subtotalReferencia() - this.totalReferencia(),
  );

  /** % EFECTIVO del descuento sobre el subtotal bruto. Cuando todos los
   *  ítems llevan el mismo descuento individual coincide con ese %; cuando
   *  difieren refleja el promedio ponderado por peso de cada línea
   *  (`descTotal_$ / subtotalBruto × 100`). Se muestra en el input
   *  "Descuento global" y, si el operador lo edita, ese nuevo % se copia a
   *  cada ítem (no se "suma" encima). */
  readonly descuentoGlobal = computed(() => {
    const bruto = this.subtotalReferencia();
    if (bruto <= 0) return 0;
    return (this.descuentoTotalMonto() / bruto) * 100;
  });

  /** Snapshots de las formas de pago con el precio final ya calculado, listo
   *  para mandar al backend al generar el PDF.
   *
   *  El precio de cada forma se calcula **por ítem** con {@link precioPorForma}
   *  usando el perfil (Normal/Maquinaria) que le corresponde al rubro de cada
   *  línea — idéntico al carrito mixto del showroom: un recargo negativo
   *  descuenta (×(1+r/100)), positivo financia (/(1-r/100)) y el IVA se aplica
   *  según el perfil del rubro. El descuento individual de la línea se aplica
   *  encima. El total de la forma es la suma de esos precios por ítem.
   *
   *  Como `aplicaIva` puede diferir por ítem (un mismo presupuesto puede mezclar
   *  menaje c/IVA y maquinaria s/IVA), el flag del snapshot global refleja el
   *  perfil "normal" de la forma — es solo informativo para el footer; el monto
   *  ya viene resuelto por ítem. */
  readonly formasPagoCalculadas = computed<PresupuestoFormaPagoSnapshot[]>(() => {
    this.itemsTick();
    const items = this.items();
    return this.formasPago().map((f) => {
      const total = items.reduce((acc, it) => {
        const perfil = this.perfilForma(f, this.rubroCotizaSinIva(it.rubro));
        const unit = precioPorForma(it.pvpKtGastroConIva, it.porcIva, perfil);
        const factorDesc = 1 - (it.descuentoPorcentaje ?? 0) / 100;
        return acc + unit * factorDesc * it.cantidad;
      }, 0);
      return {
        id: f.id,
        nombre: f.nombre,
        recargoPorcentaje: f.recargoPorcentaje ?? 0,
        cantidadCuotas: f.cantidadCuotas,
        aplicaIva: f.aplicaIva ?? true,
        precioFinal: redondearMoneda(total),
        descripcion: this.descripcionForma(f),
        recargoPorcentajeMaquinaria: f.recargoPorcentajeMaquinaria,
        aplicaIvaMaquinaria: f.aplicaIvaMaquinaria,
      };
    });
  });

  /** Índice (en {@link formasPagoCalculadas}) de la forma con menor precio
   *  final, ignorando las que están en moneda extranjera. -1 si no hay
   *  ganadora clara (lista vacía, una sola, o empate). El backend hace el
   *  mismo cálculo al generar el PDF para mantener consistencia. */
  readonly indiceMejorPrecio = computed(() => calcularIndiceMejorPrecio(
    this.formasPagoCalculadas()));

  /** Clase CSS completa de cada card de forma de pago en el panel expandido.
   *  Computamos la string en TS porque combinar `[class]="'color-N'"` con
   *  `[class.es-mejor-precio]` en el template hace que Angular pise el
   *  toggle de "mejor precio" al re-evaluar la expresión string. */
  clasesFormaCard(i: number): string {
    const colorClass = `color-${(i % 10) + 1}`;
    const mejorClass = i === this.indiceMejorPrecio() ? ' es-mejor-precio' : '';
    return `forma-pago-card ${colorClass}${mejorClass}`;
  }

  /** Chips de TODAS las formas de pago para el footer sticky. Orden:
   *   1. Mejor precio primero (resaltado en verde — la "ganadora").
   *   2. El resto por precio ascendente (más barato → más caro).
   *  Esto le da al operador una lectura inmediata "de qué tan caro es cada
   *  uno respecto al efectivo": cuanto más a la derecha, más caro. Cada
   *  chip lleva un color identificador único (1-10 rotativos), el mismo
   *  que la card detallada del panel expandido. */
  readonly formasPagoFooter = computed<FormaPagoFooter[]>(() => {
    const todas = this.formasPagoCalculadas();
    if (todas.length === 0) return [];
    const idxMejor = this.indiceMejorPrecio();
    const decoradas: FormaPagoFooter[] = todas.map((f, i) => ({
      ...f,
      indiceOriginal: i,
      esMejorPrecio: i === idxMejor,
    }));
    const porPrecio = (a: FormaPagoFooter, b: FormaPagoFooter) =>
      (a.precioFinal ?? Infinity) - (b.precioFinal ?? Infinity);
    if (idxMejor >= 0) {
      const ganadora = decoradas[idxMejor];
      const otras = decoradas.filter((_, i) => i !== idxMejor).sort(porPrecio);
      return [ganadora, ...otras];
    }
    return [...decoradas].sort(porPrecio);
  });

  /** En modo cotización individual: para cada ítem, calcula sus propias
   *  formas de pago sobre el precio del ítem (cantidad × precio × (1 - desc)).
   *  Se usa tanto en la UI (preview por producto) como en el armado del
   *  payload al backend. Devuelve un array vacío si el modo está apagado. */
  readonly formasPagoPorItem = computed<GrupoItem[]>(() => {
    this.itemsTick();
    if (!this.cotizacionIndividual()) return [];
    const formasBase = this.formasPago();
    return this.items().map((it) => {
      const esMaq = this.rubroCotizaSinIva(it.rubro);
      const factor = 1 - (it.descuentoPorcentaje ?? 0) / 100;
      const total = this.precioMostrado(it) * factor * it.cantidad;
      const formas: PresupuestoFormaPagoSnapshot[] = formasBase.map((f) => {
        const perfil = this.perfilForma(f, esMaq);
        // precioPorForma da el precio unitario con el recargo del perfil ya
        // aplicado y el IVA según corresponda al rubro; el descuento de la
        // línea se aplica encima, y se multiplica por la cantidad.
        const unit = precioPorForma(it.pvpKtGastroConIva, it.porcIva, perfil);
        const precioFinal = redondearMoneda(unit * factor * it.cantidad);
        return {
          id: f.id,
          nombre: f.nombre,
          recargoPorcentaje: f.recargoPorcentaje ?? 0,
          cantidadCuotas: f.cantidadCuotas,
          aplicaIva: perfil.aplicaIva ?? true,
          precioFinal,
          descripcion: this.descripcionForma(f),
          itemSku: it.sku,
          recargoPorcentajeMaquinaria: f.recargoPorcentajeMaquinaria,
          aplicaIvaMaquinaria: f.aplicaIvaMaquinaria,
        };
      });
      return {
        item: it,
        total,
        formas,
        indiceMejorPrecio: calcularIndiceMejorPrecio(formas),
      };
    });
  });

  ngAfterViewInit(): void {
    this.focusInput();
  }

  constructor() {
    // Formas de pago activas + rubros que cotizan sin IVA — mismo endpoint que
    // el showroom. Si fallan, las señales quedan vacías (el PDF se genera igual
    // sin sección de formas; todos los rubros cotizan con IVA).
    this.precioPerfil.cargar();

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

    // Si el operador intenta cerrar la pestaña o refrescar con cambios sin
    // guardar en modo edición, dispara el confirm nativo del navegador. El
    // CanDeactivate guard se encarga de la navegación dentro de la SPA;
    // este listener cubre el caso de salir del browser.
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (!this.hasUnsavedChanges()) return;
      e.preventDefault();
      // Chrome ignora el texto y muestra su propio mensaje, pero el
      // returnValue sigue siendo necesario para que se dispare el prompt.
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    this.destroyRef.onDestroy(() => window.removeEventListener('beforeunload', beforeUnload));

    // Refocus al scan input cuando el dialog de "+ Producto genérico" se
    // CIERRA (cualquier camino: confirmar, cancelar, ESC). Sin esto, el foco
    // queda en el botón que disparó el cierre y la pistola QR / teclado no
    // alimentan el input hasta que el operador hace click.
    let dialogGenericoAbierto = false;
    effect(() => {
      const abierto = this.mostrarDialogGenerico();
      if (dialogGenericoAbierto && !abierto) {
        this.focusInput();
      }
      dialogGenericoAbierto = abierto;
    });

    // Observa el alto del footer sticky y lo refleja en `footerHeight()`.
    // El footer crece cuando los chips de formas de pago hacen flex-wrap a
    // 2+ líneas — sin este ajuste, el padding-bottom estático del main no
    // alcanza y el footer tapa los últimos ítems del detalle.
    effect((onCleanup) => {
      const el = this.footerSticky()?.nativeElement;
      if (!el || typeof window === 'undefined') return;
      const update = () => this.footerHeight.set(el.offsetHeight);
      const obs = new ResizeObserver(update);
      obs.observe(el);
      update();
      onCleanup(() => obs.disconnect());
    });
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

        const skuGen = this.skuGenerico();
        // Los items genéricos NO se refrescan contra catálogo (su SKU es el
        // comodín y no representa un producto real). Los listamos aparte para
        // saltearlos en el lookup bulk de abajo.
        const skus = det.items
          .filter((it) => skuGen == null || it.sku !== skuGen)
          .map((it) => it.sku);
        const baseItems: PresupuestoItem[] = det.items.map((it, idx) => {
          const esGenerico = skuGen != null && it.sku === skuGen;
          return {
            sku: it.sku,
            // Genéricos: la descripción tipeada por el operador queda en el
            // detalle persistido; si por alguna razón está vacía, caemos a
            // comentarios (que es el espejo) para no romper el render.
            descripcion: esGenerico
              ? (it.descripcion || it.comentarios || '')
              : it.descripcion,
            // Rubro: si el detalle no lo trae (presupuestos viejos persistidos
            // antes del campo), lo dejamos null; el refresh posterior lo pisa
            // con el dato actual del cache.
            rubro: it.rubro ?? null,
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
            habilitado: esGenerico ? true : null,
            imagenUrl: null,
            sincronizadoAt: esGenerico ? new Date().toISOString() : null,
            uid: esGenerico ? `gen-edit-${idx}-${Date.now()}` : `${it.sku}-edit-${idx}`,
            cantidad: it.cantidad,
            descuentoPorcentaje: it.descuentoPorcentaje ?? 0,
            generico: esGenerico,
            comentarios: it.comentarios ?? (esGenerico ? it.descripcion : null),
          };
        });
        this.items.set(baseItems);
        this.cargandoEdicion.set(false);
        // Al cargar el detalle original no hay cambios pendientes.
        this.hayCambiosSinGuardar.set(false);
        // Hidrata el estado "convertido" desde el backend. Si la response
        // todavía no trae el campo (backend viejo), queda en null y el botón
        // "Crear pedido" aparece habilitado — el control adicional vive en
        // /historial. Con backend actualizado, los presupuestos ya
        // convertidos muestran directamente el pill "→ Pedido #N".
        this.pedidoIdConvertido.set(det.convertidoEnPedidoId ?? null);
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
                  // Genéricos no se refrescan contra catálogo — su SKU es
                  // comodín y la descripción/precio del operador es la fuente.
                  if (it.generico) return it;
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

  /** Abre el dialog "Crear pedido en DUX". Solo disponible en modo edición:
   *  el dialog carga el detalle persistido desde el backend (no la versión
   *  en memoria), por eso si hay cambios sin guardar el botón está
   *  deshabilitado con tooltip que pide guardar primero. */
  abrirCrearPedido(): void {
    if (!this.esModoEdicion()) return;
    if (this.hayCambiosSinGuardar()) {
      this.warn('Guardá los cambios antes de generar el pedido.');
      return;
    }
    if (this.pedidoIdConvertido() != null) return;
    this.mostrarDialogCrearPedido.set(true);
  }

  /** Output del {@link CrearPedidoDialog} cuando el pedido se creó OK. */
  onPedidoCreado(evt: { presupuestoId: number; pedidoLocalId: number }): void {
    this.pedidoIdConvertido.set(evt.pedidoLocalId);
  }

  /** Implementa {@link HasUnsavedChanges} para el {@link unsavedChangesGuard}.
   *  Solo bloquea la navegación cuando se está EDITANDO un presupuesto y
   *  hay cambios pendientes — durante la creación inicial el operador
   *  puede abandonar sin riesgo de perder un guardado. */
  hasUnsavedChanges(): boolean {
    return this.esModoEdicion() && this.hayCambiosSinGuardar();
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

  /** Tope de cantidad para el input de la lista de resultados. NO se topea al
   *  stock: el presupuesto no descuenta stock, así que el operador puede cargar
   *  la cantidad que quiera; el detalle muestra un pill amarillo "excede stock"
   *  si la cantidad supera el disponible. Cap alto solo para evitar absurdos. */
  cantidadMaximaResultado(_r: CatalogoItem): number {
    return 9999;
  }

  /** True si el producto es de un rubro excluido de los descuentos por
   *  escala (MAQUINAS INDUSTRIALES). El template lo usa para marcar las
   *  filas — tanto en los resultados de búsqueda como en la tabla del
   *  detalle del presupuesto — con un badge visible. */
  esRubroSinDescuento(rubro: string | null | undefined): boolean {
    return this.rubroCotizaSinIva(rubro);
  }

  /** Precio de REFERENCIA unitario a mostrar para un producto en la lista/detalle:
   *  el precio con la forma de pago destacada según el rubro del ítem — mismo
   *  criterio que el scan/visor del showroom. Delega en el servicio compartido. */
  precioMostrado(
    r: {
      pvpKtGastroConIva: number | null;
      pvpKtGastroSinIva: number | null;
      porcIva?: number | null;
      rubro?: string | null;
    },
  ): number {
    return this.precioPerfil.precioReferencia({
      pvpKtGastroConIva: r.pvpKtGastroConIva,
      pvpKtGastroSinIva: r.pvpKtGastroSinIva,
      porcIva: r.porcIva ?? null,
      rubro: r.rubro,
    });
  }

  agregarResultado(sku: string): void {
    const cant = this.cantidadResultado(sku);
    this.seleccionarResultado(sku, cant);
  }

  /** Producto que se está previsualizando en el diálogo "Ver producto".
   *  Null = diálogo cerrado. Usamos el {@link CatalogoItem} de la lista
   *  directamente (sin refetch) — los datos visibles son los mismos. */
  readonly productoPreview = signal<CatalogoItem | null>(null);

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

  private agregarItem(res: ScanResult, cantidad: number = 1): void {
    const cant = cantidad > 0 ? cantidad : 1;
    // Si el operador escaneó/buscó el SKU comodín directamente, lo rechazamos
    // y le indicamos el dialog correcto — sino se cargaría con la descripción
    // genérica de DUX ("Producto a cotizar") y, si ya hay otro genérico en el
    // detalle, el merge por SKU haría que la cantidad caiga sobre un ítem
    // incorrecto (todos los genéricos comparten el SKU).
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
      this.notificarMutacion('info', 'Cantidad actualizada',
        `${this.etiquetaItem(existente)}: ${existente.cantidad}u → ${nuevaCantidad}u`);
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
    this.notificarMutacion('success', 'Producto agregado',
      `${this.etiquetaItem(nuevo)}${cant > 1 ? ` (${cant}u)` : ''}`);
  }

  // ============================================================
  // Producto genérico — alta a mano de una línea con el SKU comodín de DUX.
  // A diferencia del flujo normal, no consulta el catálogo: el operador
  // tipea descripción + precio + IVA + cantidad, y cada confirmación crea
  // una línea NUEVA (no se mergea con otros genéricos aunque compartan SKU).
  // ============================================================
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
    // El precioConIva s/IVA se calcula sobre la marcha — el operador tipea
    // SIEMPRE c/IVA en el dialog. La descripción se duplica como comentarios
    // para que viaje al DUX cuando el presupuesto se transforme en pedido.
    // El rubro se setea a MAQUINAS INDUSTRIALES solo si el operador marcó
    // "Es maquinaria" — eso hace que la helper `rubroExcluyeDescuentos` lo
    // saque automáticamente del descuento por escala, lo mismo que pasa con
    // las máquinas reales del catálogo.
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
    this.notificarMutacion('success', 'Producto genérico agregado',
      `${this.etiquetaItem(nuevo)}${data.cantidad > 1 ? ` (${data.cantidad}u)` : ''}`);
    this.focusInput();
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
    // No se topea al stock: el presupuesto no descuenta stock. Si la cantidad
    // supera el disponible, el detalle muestra un pill amarillo informativo.
    if (it.cantidad === valor) return;
    const prev = it.cantidad;
    it.cantidad = valor;
    this.itemsTick.update((v) => v + 1);
    this.notificarMutacion('info', 'Cantidad actualizada',
      `${this.etiquetaItem(it)}: ${prev}u → ${valor}u`);
  }

  /** Tope de cantidad para el input. NO se topea al stock: el presupuesto no
   *  descuenta stock, así que el operador puede cargar la cantidad que quiera y
   *  un pill amarillo le avisa cuando excede el disponible. Cap alto solo para
   *  evitar cantidades absurdas. */
  cantidadMaximaDe(_it: PresupuestoItem): number {
    return 9999;
  }

  actualizarDescuento(it: PresupuestoItem, valor: number): void {
    if (!Number.isFinite(valor) || valor < 0) valor = 0;
    if (valor > 100) valor = 100;
    if ((it.descuentoPorcentaje ?? 0) === valor) return;
    it.descuentoPorcentaje = valor;
    this.itemsTick.update((v) => v + 1);
    this.notificarMutacion('info', 'Descuento actualizado',
      `${this.etiquetaItem(it)}: ${valor}%`);
  }

  eliminarItem(uid: string): void {
    const it = this.items().find((x) => x.uid === uid);
    this.items.set(this.items().filter((x) => x.uid !== uid));
    if (it) {
      this.notificarMutacion('warn', 'Producto quitado', this.etiquetaItem(it));
    }
  }

  vaciar(): void {
    const cantidad = this.items().length;
    this.items.set([]);
    this.focusInput();
    if (cantidad > 0) {
      this.notificarMutacion('warn', 'Detalle vaciado',
        `Se quitaron ${cantidad} ${cantidad === 1 ? 'producto' : 'productos'}.`);
    }
  }

  // ============================================================
  // Subtotal por línea — para mostrar en la tabla. Usa el precio EFECTIVO
  // mostrado (forma primaria, según rubro) con el descuento individual, para
  // que coincida con la columna "Precio" y con los totales globales.
  // ============================================================
  totalLinea(it: PresupuestoItem): number {
    const desc = it.descuentoPorcentaje ?? 0;
    return this.precioMostrado(it) * (1 - desc / 100) * it.cantidad;
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
    const actuales = this.items();
    if (actuales.length === 0) return;
    const todosIguales = actuales.every((it) => (it.descuentoPorcentaje ?? 0) === valor);
    if (todosIguales) return;
    for (const it of actuales) it.descuentoPorcentaje = valor;
    this.itemsTick.update((v) => v + 1);
    this.notificarMutacion('info', 'Descuento global aplicado',
      `${valor}% sobre ${actuales.length} ${actuales.length === 1 ? 'ítem' : 'ítems'}.`);
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
      // Rubro: para genéricos puede ser "MAQUINAS INDUSTRIALES" si el operador
      // marcó la casilla "es maquinaria" — el PDF lo usa para excluir esa
      // línea de las columnas de descuento por escala. Para items del catálogo
      // el backend de todas formas lo ignora (toma el del cache real).
      rubro: it.rubro ?? null,
      cantidad: it.cantidad,
      precioConIva: it.pvpKtGastroConIva ?? 0,
      porcIva: it.porcIva ?? 21,
      descuentoPorcentaje: it.descuentoPorcentaje ?? 0,
      // Precio unitario con la forma de pago de referencia, ya según rubro
      // (c/IVA menaje, s/IVA maquinaria). Redondeado para coincidir con el PDF.
      precioReferencia: redondearMoneda(this.precioMostrado(it)),
      // Solo viaja para items genéricos — DUX lo pone como `comentarios` de
      // la línea al transformar el presupuesto en pedido.
      comentarios: it.comentarios ?? null,
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
    // El dialog unificado funciona como confirmación + form de cliente. Si
    // los datos están incompletos, el operador los completa adentro antes
    // de confirmar; si ya están cargados, los revisa y confirma.
    this.abrirDialogCliente('previsualizar');
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
        // Abrimos el PDF en la pestaña pre-abierta para que el operador lo
        // previsualice. NO auto-descargamos cuando el preview se abre OK:
        // si quiere bajarlo a disco (para mandarlo por WhatsApp/email
        // manual), lo hace desde el visor del browser. Cuando el browser
        // bloquea el popup, el helper cae a auto-descarga como plan B y
        // el toast lo aclara.
        const resultado = abrirPdfEnPreview(res, 'presupuesto.pdf', previewTab);
        if (resultado == null) {
          this.warn('El backend no devolvió un PDF.');
          return;
        }
        this.hayCambiosSinGuardar.set(false);
        const detallePreview = editandoId != null
          ? `Presupuesto #${editandoId} actualizado — se abrió para previsualizar.`
          : 'Se abrió para previsualizar. Podés bajar el PDF desde el visor.';
        const detalleDescarga = editandoId != null
          ? `Presupuesto #${editandoId} actualizado — PDF descargado (el browser bloqueó la pestaña preview).`
          : 'PDF descargado — el browser bloqueó la pestaña preview.';
        this.toast.add({
          severity: 'success',
          summary: editandoId != null ? 'Cambios guardados' : 'Presupuesto generado',
          detail: resultado.previewAbierto ? detallePreview : detalleDescarga,
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

  abrirDialogEnviar(): void {
    if (!this.hayItems()) {
      this.warn('Tenés que seleccionar al menos un producto para enviar.');
      return;
    }
    // Validamos al confirmar (dentro del dialog), no al abrirlo, porque el
    // dialog incluye los inputs editables del cliente — si falta el email
    // el operador lo carga adentro.
    this.abrirDialogCliente('enviar');
  }

  /** Abre el dialog unificado de "Datos del cliente + confirmación" en el
   *  modo correspondiente a {@code accion}:
   *   - `'previsualizar'`: el botón principal genera el PDF (POST/PUT).
   *   - `'enviar'`: el botón principal encola el envío por email.
   *   - `null`: edición libre — solo "Cerrar" en el footer.
   *  El form interno bindea los signals existentes ({@link clienteNombre},
   *  {@link clienteEmail}, etc.) así que los cambios persisten aunque el
   *  operador cierre el dialog sin confirmar. */
  abrirDialogCliente(accion: 'previsualizar' | 'enviar' | null): void {
    this.accionPendienteDialog.set(accion);
    this.mostrarDialogCliente.set(true);
  }

  /** Botón principal del dialog. Valida los datos del cliente según la
   *  acción (email obligatorio solo si se va a enviar) y dispara el flujo
   *  correspondiente. Si la acción es `null` (edición libre), simplemente
   *  cierra el dialog. */
  confirmarDialogCliente(): void {
    const accion = this.accionPendienteDialog();
    if (accion === null) {
      this.mostrarDialogCliente.set(false);
      return;
    }
    if (!this.validarDatosCliente()) return;
    if (accion === 'enviar' && !this.validarEmailParaEnvio()) return;
    this.mostrarDialogCliente.set(false);
    if (accion === 'previsualizar') {
      this.ejecutarPrevisualizar();
    } else {
      this.enviarPorEmail();
    }
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
        this.hayCambiosSinGuardar.set(false);
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

  /** Notifica al operador una mutación sobre el detalle del presupuesto
   *  (agregar / modificar / quitar / vaciar / descuento global) y marca el
   *  estado como "cambios sin guardar". El toast tiene vida corta para no
   *  saturar cuando se hacen varios cambios seguidos. */
  private notificarMutacion(severity: 'success' | 'info' | 'warn', summary: string, detail: string): void {
    this.toast.add({ severity, summary, detail, life: 1000 });
    this.hayCambiosSinGuardar.set(true);
  }

  /** Etiqueta corta del ítem para usar en los toasts: descripción truncada o
   *  el SKU como fallback. Mantiene los toasts legibles sin desbordar. */
  private etiquetaItem(it: { descripcion?: string | null; sku: string }): string {
    const desc = (it.descripcion ?? '').trim();
    if (!desc) return it.sku;
    return desc.length > 40 ? `${desc.slice(0, 40)}…` : desc;
  }

  /** Sugerencias del autocomplete del email — delega en el helper
   *  compartido {@link calcularSugerenciasEmail}. */
  onCompletarEmail(event: AutoCompleteCompleteEvent): void {
    this.sugerenciasEmail.set(calcularSugerenciasEmail(event.query));
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
  private descripcionForma(_f: FormaPago): string {
    // No derivamos descripción para la forma: el nombre ya es descriptivo
    // ("Efectivo", "2 cuotas"…), el detalle de cuotas se muestra aparte
    // ("N cuotas de $X") y el "% de descuento" depende del perfil del producto
    // (sería engañoso a nivel forma). Repetir "N cuotas" como descripción era
    // redundante con el nombre.
    return '';
  }
}

/** En modo cotización individual: un ítem + sus formas de pago calculadas
 *  sobre el precio del ítem. Solo se construye en
 *  {@link PresupuestosPage.formasPagoPorItem}; el backend recibe items y
 *  formas planos (cada forma con su `itemSku`) y reagrupa por su cuenta. */
interface GrupoItem {
  item: PresupuestoItem;
  /** Total efectivo del ítem (precio efectivo × cantidad × (1 - descuento)),
   *  coherente con el precio mostrado en el resto del armado. */
  total: number;
  formas: PresupuestoFormaPagoSnapshot[];
  indiceMejorPrecio: number;
}

/** Snapshot de forma de pago enriquecido para el footer compacto: trae el
 *  índice original (para resaltar la misma "mejor precio" en el panel
 *  expandido) y un flag para pintar el chip ganador con el badge verde. */
interface FormaPagoFooter extends PresupuestoFormaPagoSnapshot {
  indiceOriginal: number;
  esMejorPrecio: boolean;
}
