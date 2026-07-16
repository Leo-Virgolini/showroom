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
  untracked,
  viewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subject, debounceTime, firstValueFrom } from 'rxjs';
import { ActivatedRoute } from '@angular/router';
import { ConfirmationService, MessageService } from 'primeng/api';
import { AutoCompleteCompleteEvent, AutoCompleteModule } from 'primeng/autocomplete';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { DialogModule } from 'primeng/dialog';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { InputMaskModule } from 'primeng/inputmask';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { SelectModule } from 'primeng/select';
import { TextareaModule } from 'primeng/textarea';
import { SelectButtonModule } from 'primeng/selectbutton';
import { TooltipModule } from 'primeng/tooltip';
import {
  CambioPrecio,
  ClienteAutocompletar,
  EnviarPresupuestoRequest,
  FormaPago,
  GenerarPresupuestoRequest,
  PresupuestoDetalle,
  PresupuestoFormaPagoSnapshot,
  PresupuestoItem,
  PresupuestoVisor,
  OPCIONES_RUBRO_CLIENTE,
} from '../models';
import {
  calcularIndiceMejorPrecio,
  iconoFormaReferencia,
  precioPorForma,
  redondearMoneda,
} from '../precio-referencia.util';
import { PrecioPerfilService } from '../precio-perfil.service';
import { PresupuestoDesdeAtencionService } from '../presupuesto-desde-atencion.service';
import { ShowroomService } from '../showroom.service';
import { BackendStatusService } from '../backend-status.service';
import { SesionClienteService } from '../sesion-cliente.service';
import { construirVisorUrl, generarQrDataUrl } from '../visor-qr.util';
import { CrearPedidoDialog } from '../crear-pedido-dialog/crear-pedido-dialog';
import { CarritoBuscador } from '../carrito-buscador/carrito-buscador';
import { CarritoTabla } from '../carrito-tabla/carrito-tabla';
import { CarritoMutacion } from '../models';
import { abrirPdfEnPreview } from '../download.utils';
import { crearTelefonoLookup } from '../telefono-lookup.util';
import { calcularSugerenciasEmail } from '../email-suggestions.utils';
import { toastError } from '../toast.utils';
import { seleccionarTextoAlEnfocar } from '../dom.utils';
import { PageHeader } from '../page-header/page-header';
import { QrCelularDialog } from '../qr-celular-dialog/qr-celular-dialog';
import { SyncButton } from '../sync-button/sync-button';
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
    AutoCompleteModule,
    ButtonModule,
    CardModule,
    DialogModule,
    IconFieldModule,
    InputIconModule,
    InputMaskModule,
    InputNumberModule,
    InputTextModule,
    ProgressSpinnerModule,
    SelectModule,
    TextareaModule,
    SelectButtonModule,
    TooltipModule,
    CrearPedidoDialog,
    CarritoBuscador,
    CarritoTabla,
    PageHeader,
    QrCelularDialog,
    SyncButton,
  ],
  templateUrl: './presupuestos-page.html',
  styleUrl: './presupuestos-page.scss',
})
export class PresupuestosPage implements AfterViewInit, HasUnsavedChanges {
  private readonly api = inject(ShowroomService);
  private readonly toast = inject(MessageService);
  private readonly confirmationService = inject(ConfirmationService);
  private readonly backendStatus = inject(BackendStatusService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly route = inject(ActivatedRoute);
  private readonly precioPerfil = inject(PrecioPerfilService);
  private readonly sesionService = inject(SesionClienteService);
  private readonly presupuestoAtencion = inject(PresupuestoDesdeAtencionService);

  /** Si está en una URL `/presupuestos/editar/:id`, el id se setea acá y la
   *  pantalla pasa a modo edición: el botón principal dice "Guardar cambios",
   *  el confirm dialog cambia de copy, y `previsualizar()` llama al PUT en
   *  lugar del POST de creación. Null = modo creación (URL `/presupuestos`). */
  readonly presupuestoEditandoId = signal<number | null>(null);
  /** Id REAL de la sesión de atención de la que provino este presupuesto (si
   *  vino de una) — no un sentinel. No nulo ⇒ al guardar (preview/enviar) se
   *  manda como `origenAtencionSesionId` para que el backend cierre esa
   *  sesión, pero SOLO SI todavía es la sesión activa del operador (si en
   *  otra pestaña ya arrancó otra atención, el backend no toca nada). Se
   *  limpia tras el primer guardado exitoso. */
  private readonly origenAtencionSesionId = signal<number | null>(null);
  /** True mientras se carga el detalle del presupuesto a editar — pinta un
   *  overlay simple para que el operador no toque el form a medio llenar. */
  readonly cargandoEdicion = signal(false);
  /** True cuando hubo cambios en el detalle (agregar/modificar/quitar ítems
   *  o aplicar descuento global) desde el último guardado. En modo edición se
   *  pinta un badge "Sin guardar" cerca del botón "Guardar cambios" para que
   *  el operador no se olvide de persistir antes de salir. Se resetea al
   *  guardar/generar con éxito y al cargar inicial el detalle en edición. */
  readonly hayCambiosSinGuardar = signal(false);

  /** Ref al `carrito-buscador` — el scan/búsqueda y su input viven ahí; el
   *  host lo usa para refocar el scan tras cerrar SUS PROPIOS diálogos
   *  (QR, nuevo cliente, sync) y tras vaciar la tabla. */
  readonly buscador = viewChild(CarritoBuscador);
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

  /** Dispositivo táctil (pointer grueso, ej. tablet con la pistola QR). En
   *  ese caso evitamos el auto-refoco al scan input tras cada click/cierre de
   *  dialog: robar el foco abriría el teclado virtual con cada toque. El flujo
   *  de scan/búsqueda sí refoca igual (la pistola debe alimentar el input). */
  private readonly esTactil =
    typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;

  // ------------------------------------------------------------
  // Lista de ítems — el scan/búsqueda que la alimenta ahora vive por
  // completo en `carrito-editor` (autónomo); el host solo posee la lista.
  // ------------------------------------------------------------
  /** Lista de ítems del presupuesto — orden de agregado preservado.
   *  Solo se reemplaza el array al AGREGAR o ELIMINAR ítems; las ediciones
   *  inline (cantidad, descuento) mutan el objeto in-place para no
   *  re-renderizar la fila completa de la tabla — sino p-inputNumber pierde
   *  el foco con cada keystroke al recibir un writeValue desde afuera. */
  readonly items = signal<PresupuestoItem[]>([]);
  /** Contador que se incrementa cuando un ítem se muta in-place (no cambia la
   *  referencia del array {@link items}) — bumpeado desde {@link onCarritoMutacion}
   *  cuando `carrito-editor` muta cantidad/descuento in-place. Los
   *  {@link computed} que dependen de propiedades de los ítems (totales) leen
   *  este signal para forzar el recompute sin necesidad de reemplazar el
   *  array. Independiente del tick interno de `carrito-editor` (cada uno CD
   *  su propio árbol). */
  private readonly itemsTick = signal(0);

  // ------------------------------------------------------------
  // Datos del cliente / observaciones
  // ------------------------------------------------------------
  readonly clienteNombre = signal('');
  readonly clienteTelefono = signal('');
  readonly clienteEmail = signal('');
  /** Cliente que YA tiene el teléfono ingresado (null = ninguno) — alimenta el
   *  aviso "este teléfono ya pertenece a X". */
  readonly clientePorTelefono = signal<ClienteAutocompletar | null>(null);

  /** ngModelChange del teléfono: setea el signal + chequea si el teléfono ya
   *  pertenece a un cliente (para el aviso). */
  onClienteTelefonoChange(value: string | null | undefined): void {
    this.clienteTelefono.set(value ?? '');
    this.chequearTelefonoExistente(value ?? '');
  }

  /** Chequea si el teléfono ya es de un cliente (a partir de 8 dígitos) y
   *  actualiza {@link clientePorTelefono}. La lógica (normalización + dedupe +
   *  guard de respuesta tardía) vive en {@link crearTelefonoLookup}, compartida
   *  con la pantalla de clientes. */
  private readonly chequearTelefonoExistente = crearTelefonoLookup(
    (d) => this.api.buscarClientePorTelefono(d),
    this.destroyRef,
    (cli) => this.clientePorTelefono.set(cli),
  );
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

  /** Opciones del dropdown de rubro (constante compartida con crear-pedido). */
  readonly opcionesRubro = OPCIONES_RUBRO_CLIENTE;

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
    // En individual el selector no aplica; volver a "Todas" deja el estado
    // coherente y evita mandar un id que el backend ignoraría.
    if (value === 'individual') this.formaPagoSeleccionadaId.set(null);
  }

  /** Forma de pago elegida para el PDF agregado. null = "Todas" (default):
   *  precio efectivo por ítem + sección comparativa de formas. Solo aplica en
   *  modo agregado; al pasar a individual se resetea a "Todas". */
  readonly formaPagoSeleccionadaId = signal<number | null>(null);

  /** Selecciona/deselecciona una forma de pago desde un chip o card del footer.
   *  Toggle: si ya está seleccionada, vuelve a "Todas" (null). Setea el mismo
   *  signal que el dropdown de la toolbar, así el precio en vivo y el PDF la
   *  toman automáticamente. */
  seleccionarForma(id: number | null): void {
    this.formaPagoSeleccionadaId.set(this.formaPagoSeleccionadaId() === id ? null : id);
  }

  // ------------------------------------------------------------
  // Formas de pago activas (selector global)
  // ------------------------------------------------------------
  readonly formasPago = this.precioPerfil.formasPago;

  /** True si el rubro cotiza sin IVA (su precio base es el PVP sin IVA y queda
   *  fuera del descuento por escala). Copiado de showroom-page. */
  rubroCotizaSinIva(rubro: string | null | undefined): boolean {
    return this.precioPerfil.rubroCotizaSinIva(rubro);
  }

  /** Recargo + aplicaIva del perfil (Normal o Maquinaria) de una forma según el
   *  rubro del ítem. Maquinaria: recargo null → 0 (no hereda del normal);
   *  aplicaIva null → false. Misma lógica que showroom-page.perfilForma. */
  private perfilForma(
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
  /** True mientras se traen los precios actuales del catálogo para el botón
   *  "Actualizar precios" (modo edición). Pinta el botón en loading y lo
   *  deshabilita para evitar disparos dobles. */
  readonly actualizandoPrecios = signal(false);
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

  /** SKU comodín derivado del estado del backend — usado acá SOLO para
   *  distinguir los ítems genéricos al hidratar un presupuesto en edición
   *  (ver {@link cargarParaEditar}). El scan/búsqueda, el botón "+ Producto
   *  genérico" y su dialog viven ahora en `carrito-editor`, que lee el mismo
   *  signal por su cuenta (inyecta {@link BackendStatusService} directo). */
  readonly skuGenerico = this.backendStatus.skuProductoGenerico;

  /** Id del pedido DUX al que se convirtió este presupuesto durante la
   *  sesión actual. Se setea cuando {@link CrearPedidoDialog} emite
   *  {@code pedidoCreado}; el botón "Crear pedido" se deshabilita y aparece
   *  un pill "→ Pedido #N" en su lugar para evitar duplicar la conversión.
   *  No se hidrata en {@link cargarParaEditar} porque el detalle del backend
   *  todavía no expone el flag — el control "no duplicar" para presupuestos
   *  ya convertidos antes de esta sesión vive en /historial. */
  readonly pedidoIdConvertido = signal<number | null>(null);
  /** Fechas del presupuesto editado para detectar "editado tras convertir":
   *  si {@link #modificadoAtPresupuesto} es posterior a {@link #convertidoAtPresupuesto}
   *  el presupuesto cambió después de generar el pedido y se ofrece regenerar.
   *  Se hidratan al cargar y se actualizan al guardar/regenerar en esta sesión. */
  readonly convertidoAtPresupuesto = signal<string | null>(null);
  readonly modificadoAtPresupuesto = signal<string | null>(null);
  /** Id del pedido anterior cuando el dialog se abre en modo "regenerar". */
  readonly pedidoAnteriorParaRegenerar = signal<number | null>(null);

  /** True si el presupuesto en edición ya tiene pedido y se modificó después de
   *  generarlo → se ofrece "Regenerar pedido" (deshabilitado si hay cambios sin
   *  guardar: el dialog regenera desde el detalle PERSISTIDO). */
  readonly editadoTrasConvertir = computed(() => {
    const conv = this.convertidoAtPresupuesto();
    const mod = this.modificadoAtPresupuesto();
    return this.pedidoIdConvertido() != null && !!conv && !!mod
      && new Date(mod).getTime() > new Date(conv).getTime();
  });

  /** Footer sticky con TOTAL + formas de pago. Compacto por default (chips
   *  de TODAS las formas con su precio en 1 línea, con flex-wrap a 2 líneas
   *  si no entran); cuando el operador toca el chevron se expande hacia
   *  arriba mostrando las cards completas con barras de color, descripción
   *  detallada y desglose por cuotas. En modo individual el panel expandido
   *  muestra el preview por producto en lugar de la lista global. */
  readonly footerExpandido = signal(false);

  // ------------------------------------------------------------
  // Sesión de cliente COMPARTIDA con el showroom (misma SesionShowroom por
  // operador). La badge permite asociar/finalizar un cliente desde acá; es
  // opcional (el presupuesto se arma y se muestra en el visor con o sin
  // sesión y con o sin cliente). El nombre del presupuesto sale del campo
  // propio `clienteNombre`, que se prellena del de la sesión cuando está vacío.
  // ------------------------------------------------------------
  /** Sesión de cliente compartida con el showroom — el estado vive en
   *  {@link SesionClienteService} (misma SesionShowroom por operador). */
  readonly sesionActiva = this.sesionService.sesion;
  readonly haySesionActiva = this.sesionService.haySesionActiva;
  readonly mostrarDialogoNuevoCliente = signal(false);
  readonly nombreNuevoCliente = signal('');
  readonly iniciandoSesion = signal(false);

  // ------------------------------------------------------------
  // Visor de presupuesto (espejo read-only en el celular del cliente) — QR +
  // publicación en vivo del armado. Reusa el mismo VisorConfig.baseUrl que el
  // visor del showroom para el caso IP-vs-DNS.
  // ------------------------------------------------------------
  readonly mostrarDialogVisor = signal(false);
  readonly qrVisorDataUrl = signal<string | null>(null);
  readonly qrVisorGenerando = signal(false);
  readonly visorBaseConfig = signal('');
  /** Token de la sesión de atención activa, traído al abrir el dialog del QR.
   *  Null si todavía no se pidió o si no hay sesión activa. */
  readonly visorToken = signal<string | null>(null);
  /** URL del visor de presupuesto con el token de la sesión activa. Vacío si
   *  todavía no hay token (sin sesión o dialog no abierto). */
  readonly visorUrl = computed(() => {
    const token = this.visorToken();
    if (!token) return '';
    return construirVisorUrl(this.visorBaseConfig(), token, 'visor-presupuesto');
  });
  /** Coalesce los cambios del armado antes de publicarlos al visor (debounce). */
  private readonly visorPublish$ = new Subject<void>();

  /** Todos los ítems entran al PDF — ya no hay checkbox por fila para
   *  excluir ítems individuales. Si el operador no quiere un ítem, lo borra. */
  readonly hayItems = computed(() => {
    this.itemsTick();
    return this.items().length > 0;
  });

  /** True si hay al menos un ítem de catálogo (no genérico). Los genéricos no
   *  tienen precio en el catálogo (su SKU es comodín), así que el botón
   *  "Actualizar precios" no aplica cuando todos los ítems son genéricos. */
  readonly hayItemsCatalogo = computed(() => {
    this.itemsTick();
    return this.items().some((it) => !it.generico);
  });

  /** Cambios de precio detectados al abrir el presupuesto en edición:
   *  uid del ítem → {precioGuardado, precioActual}. Se llena en
   *  {@link cargarParaEditar} comparando lo persistido contra el catálogo
   *  actual (mismo lookup que ya se hace, sin llamadas extra), y se vacía
   *  cuando el operador aplica "Actualizar precios". Alimenta el banner y el
   *  pill por fila. Vacío = todo al día (o modo creación). */
  readonly cambiosPrecio = signal<Map<string, CambioPrecio>>(new Map());

  /** Cantidad de ítems cuyo precio/IVA cambió respecto al guardado — el
   *  banner de aviso se muestra solo cuando es > 0 en modo edición. */
  readonly cantidadPreciosCambiados = computed(() => this.cambiosPrecio().size);

  /** Objeto de la forma de pago elegida (null = "Todas"). */
  readonly formaPagoSeleccionada = computed<FormaPago | null>(() => {
    const id = this.formaPagoSeleccionadaId();
    if (id == null) return null;
    return this.formasPago().find((f) => f.id === id) ?? null;
  });

  /** Precio unitario a MOSTRAR según la forma elegida; con "Todas" cae al
   *  precio Efectivo (referencia). Solo visual — el payload sigue usando
   *  `precioMostrado` (Efectivo). */
  precioVisualItem(it: {
    pvpKtGastroConIva: number | null;
    pvpKtGastroSinIva: number | null;
    porcIva?: number | null;
    rubro?: string | null;
  }): number {
    return this.precioPerfil.precioVisualItem(it, this.formaPagoSeleccionada());
  }

  /** Subtotal BRUTO en la forma elegida (sin descuentos individuales). Con
   *  "Todas" coincide con `subtotalReferencia`. */
  readonly subtotalVisual = computed(() => {
    this.itemsTick();
    return this.items().reduce((acc, it) => acc + this.precioVisualItem(it) * it.cantidad, 0);
  });

  /** Total NETO en la forma elegida (con los descuentos individuales). Con
   *  "Todas" coincide con `totalReferencia`. */
  readonly totalVisual = computed(() => {
    this.itemsTick();
    return this.items().reduce(
      (acc, it) => acc + this.precioVisualItem(it) * it.cantidad * (1 - (it.descuentoPorcentaje ?? 0) / 100),
      0,
    );
  });

  /** Ahorro por descuentos individuales en la forma elegida (bruto − neto). */
  readonly descuentoVisualMonto = computed(() => this.subtotalVisual() - this.totalVisual());

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
        descripcion: null,
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
    const sel = this.formasPagoCalculadas()[i]?.id === this.formaPagoSeleccionadaId()
      ? ' seleccionada'
      : '';
    return `forma-pago-card ${colorClass}${mejorClass}${sel}`;
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
          descripcion: null,
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
    this.buscador()?.focusScanInput();
  }

  constructor() {
    // Formas de pago activas + rubros que cotizan sin IVA — mismo endpoint que
    // el showroom. Si fallan, las señales quedan vacías (el PDF se genera igual
    // sin sección de formas; todos los rubros cotizan con IVA).
    this.precioPerfil.cargar();

    // Purga el map de "cambios de precio" cuando un ítem se quita del
    // detalle (por `carrito-editor.eliminarItem`/`vaciar`, que ya NO tocan
    // este map directamente — el componente ni siquiera tiene acceso de
    // escritura, solo lee el map vía su input `cambiosPrecio`). Sin este
    // effect, el contador del banner "precios cambiaron" quedaría inflado
    // con uids que ya no están en el detalle.
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
          const nm = new Map([...m].filter(([k]) => vivos.has(k)));
          this.cambiosPrecio.set(nm);
        }
      });
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

    // Precarga desde una atención del showroom: si NO estamos editando y hay un
    // borrador pendiente, lo consumimos (una sola vez) y poblamos el form. El
    // presupuesto arranca en modo AGREGADO (cotizacionIndividual=false).
    if (!idParam) {
      const borrador = this.presupuestoAtencion.consumir();
      if (borrador) {
        this.items.set(borrador.items);
        if (borrador.clienteNombre) this.clienteNombre.set(borrador.clienteNombre);
        this.formaPagoSeleccionadaId.set(borrador.formaPagoSeleccionadaId);
        this.cotizacionIndividual.set(false);
        this.origenAtencionSesionId.set(borrador.sesionId ?? null);
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

    // Refoco "casi-siempre" al scan input: cualquier click que no caiga sobre
    // un campo editable (ni con un dialog abierto) devuelve el foco al input
    // para que la pistola QR siga escaneando sin tener que clickearlo. Cubre
    // eliminar ítems, botones del toolbar, el toggle de modo, el footer,
    // descartar toasts y clicks en zonas vacías. Solo en desktop (pointer
    // fino): en tablets robar el foco abriría el teclado virtual con cada
    // toque, así que ni siquiera registramos el listener.
    if (typeof window !== 'undefined') {
      if (!this.esTactil) {
        const refocusOnClick = () => {
          // Diferimos un tick para leer el estado YA asentado: el foco del
          // elemento clickeado y cualquier overlay que el click haya abierto.
          // El mask de un p-dialog / del p-confirmDialog global se renderiza
          // en el change detection que dispara el click (microtask), antes de
          // este setTimeout (macrotask), así que acá ya está en el DOM.
          setTimeout(() => {
            // Hay un overlay modal abierto (dialog propio, de un componente
            // hijo, o el confirmDialog global de app.html): no le robamos el
            // foco al control que vive dentro del overlay.
            if (document.querySelector('.p-dialog-mask')) return;
            // El operador está editando un campo (cantidad, descuento,
            // observaciones): respetamos su foco.
            if (this.esCampoEditable(document.activeElement)) return;
            this.buscador()?.focusScanInput();
          }, 0);
        };
        document.addEventListener('click', refocusOnClick);
        this.destroyRef.onDestroy(() => document.removeEventListener('click', refocusOnClick));
      }

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
    }

    // Refoco al scan input cuando se CIERRA cualquiera de los dialogs propios
    // (+ Producto genérico, Datos del cliente, Crear pedido, Ver producto),
    // por cualquier camino: confirmar, cancelar o ESC. Sin esto el foco queda
    // en el botón que disparó el cierre y la pistola QR / teclado no alimentan
    // el input hasta clickearlo. Un solo effect sobre el OR de los dialogs:
    // al pasar de abierto a cerrado refoca, respetando el guard táctil.
    let habiaDialogAbierto = false;
    effect(() => {
      const hayDialog = this.algunDialogAbierto();
      if (habiaDialogAbierto && !hayDialog) {
        this.focusInputAuto();
      }
      habiaDialogAbierto = hayDialog;
    });

    // Observa el alto del footer sticky y lo refleja en `footerHeight()`.
    // El footer crece cuando los chips de formas de pago hacen flex-wrap a
    // 2+ líneas — sin este ajuste, el padding-bottom estático del main no
    // alcanza y el footer tapa los últimos ítems del detalle.
    // A prueba de loops: se difiere a requestAnimationFrame y solo escribe la
    // señal si el alto cambió (evita re-entradas síncronas y ciclos de
    // change-detection; la causa raíz —el toggle de la scrollbar— la corta
    // `scrollbar-gutter: stable` en styles.scss).
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

    // --- Sesión de cliente compartida con el showroom ---
    // El estado lo centraliza SesionClienteService (hidratación + SSE). Acá solo
    // hidratamos al entrar y prellenamos el nombre del presupuesto (si está
    // vacío) cuando hay sesión — el operador puede sobreescribirlo o borrarlo.
    this.sesionService.hidratar().subscribe({
      error: () => { /* sin sesión: la badge queda en "Cliente" (asociar) */ },
    });
    effect(() => {
      const s = this.sesionService.sesion();
      // Leemos clienteNombre sin trackearlo para no re-disparar el effect al
      // escribirlo (solo reacciona a cambios de la sesión).
      if (s.id != null && s.nombre && !untracked(() => this.clienteNombre()).trim()) {
        this.clienteNombre.set(s.nombre);
      }
    });

    // --- Publicación en vivo al visor de presupuesto ---
    // Cualquier cambio del armado o del nombre del cliente arma un snapshot y
    // lo publica con debounce (para no inundar de requests al teclear). Leer
    // los computed de abajo establece las dependencias del effect: totales y
    // formas dependen de `itemsTick`/`formasPago`, así que cubren las
    // mutaciones in-place de cantidad/descuento.
    effect(() => {
      this.itemsTick();
      this.clienteNombre();
      this.formasPagoFooter();
      this.totalReferencia();
      this.visorPublish$.next();
    });
    this.visorPublish$
      .pipe(debounceTime(400), takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.api.publicarPresupuestoVisor(this.armarSnapshotVisor())
          .subscribe({ error: () => { /* el visor reintenta en el próximo cambio */ } });
      });

    // Al salir de la pantalla, limpiamos el visor para que el celular no quede
    // mostrando un presupuesto viejo. (No usamos focusInputAuto/takeUntil acá:
    // el destroy ya está en curso; es un fire-and-forget.)
    this.destroyRef.onDestroy(() => {
      this.api.publicarPresupuestoVisor(
        { clienteNombre: null, items: [], total: 0, formasPago: [] },
      ).subscribe({ error: () => { /* no-op */ } });
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
        this.chequearTelefonoExistente(det.clienteTelefono ?? '');
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
        // Forma de pago elegida del PDF agregado — pre-selecciona el dropdown.
        this.formaPagoSeleccionadaId.set(det.formaPagoSeleccionadaId ?? null);

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
        this.convertidoAtPresupuesto.set(det.convertidoAt ?? null);
        this.modificadoAtPresupuesto.set(det.modificadoAt ?? null);
        this.buscador()?.focusScanInput();

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
              // Detecta cambios de precio/IVA respecto a lo guardado ANTES de
              // pisar descripción/stock — en este punto los precios del ítem
              // siguen siendo los del JSON persistido. No pisamos el precio
              // (eso lo hace el botón "Actualizar precios" a pedido), solo
              // avisamos: alimentamos el banner + el pill por fila.
              const cambios = new Map<string, CambioPrecio>();
              for (const it of this.items()) {
                if (it.generico) continue;
                const f = porSku.get(it.sku);
                if (!f) continue;
                // Solo avisamos cuando cambia el PRECIO DE REFERENCIA que ve el
                // cliente (precioMostrado), no los datos crudos. Así un cambio de
                // rubro que cruza menaje↔maquinaria (que SÍ cambia el precio) se
                // detecta, pero un cambio de rubro cosmético (mismo precio) no
                // pinta un falso "precio desactualizado" con dos montos iguales.
                const precioGuardado = this.precioMostrado(it);
                const precioActual = this.precioMostrado({
                  pvpKtGastroConIva: f.pvpKtGastroConIva,
                  pvpKtGastroSinIva: f.pvpKtGastroSinIva,
                  porcIva: f.porcIva,
                  rubro: f.rubro ?? it.rubro,
                });
                if (redondearMoneda(precioGuardado) === redondearMoneda(precioActual)) continue;
                cambios.set(it.uid, { precioGuardado, precioActual });
              }
              this.cambiosPrecio.set(cambios);
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
    this.pedidoAnteriorParaRegenerar.set(null);
    this.mostrarDialogCrearPedido.set(true);
  }

  /** Abre el dialog en modo "regenerar": el presupuesto ya tiene pedido y se
   *  editó después. El dialog regenera desde el detalle PERSISTIDO, así que
   *  exigimos que no haya cambios sin guardar. */
  abrirRegenerarPedido(): void {
    if (!this.esModoEdicion()) return;
    const anteriorId = this.pedidoIdConvertido();
    if (anteriorId == null) return;
    if (this.hayCambiosSinGuardar()) {
      this.warn('Guardá los cambios antes de regenerar el pedido.');
      return;
    }
    this.pedidoAnteriorParaRegenerar.set(anteriorId);
    this.mostrarDialogCrearPedido.set(true);
  }

  /** Output del {@link CrearPedidoDialog} cuando el pedido se creó/regeneró OK.
   *  Actualiza el vínculo y marca `convertidoAt = ahora` para que el botón
   *  "Regenerar" desaparezca hasta una próxima edición guardada. */
  onPedidoCreado(evt: { presupuestoId: number | null; pedidoLocalId: number }): void {
    this.pedidoIdConvertido.set(evt.pedidoLocalId);
    this.convertidoAtPresupuesto.set(new Date().toISOString());
    this.pedidoAnteriorParaRegenerar.set(null);
  }

  /** Reemplaza los precios de los ítems del presupuesto por los del catálogo
   *  local (cache en BD, vía {@link ShowroomService.lookupBulk} — NO toca DUX).
   *  Solo en modo edición: un presupuesto guardado congela los precios del
   *  momento en que se creó, y la carga en edición a propósito NO los pisa
   *  (ver {@link cargarParaEditar}). Este botón es la acción EXPLÍCITA para
   *  traerlos al valor actual cuando el operador lo decide.
   *
   *  <p>Pisa únicamente precio c/IVA, s/IVA, %IVA y rubro; conserva cantidad,
   *  descuento individual, uid y comentarios. Los genéricos se saltan (su SKU
   *  es comodín y no representa un producto del catálogo). Pide confirmación
   *  antes porque reemplaza precios que pudieron negociarse con el cliente. */
  actualizarPreciosDesdeCatalogo(): void {
    const skus = this.items().filter((it) => !it.generico).map((it) => it.sku);
    if (skus.length === 0) {
      this.warn('No hay productos de catálogo para actualizar.');
      return;
    }
    this.confirmationService.confirm({
      header: '¿Actualizar precios?',
      message: 'Se van a reemplazar los precios de este presupuesto por los del '
        + 'catálogo actual. Las cantidades y los descuentos se conservan. ¿Continuás?',
      icon: 'pi pi-dollar',
      acceptButtonProps: { label: 'Actualizar', icon: 'pi pi-refresh' },
      rejectButtonProps: { label: 'Cancelar', severity: 'secondary', outlined: true },
      accept: () => this.ejecutarActualizarPrecios(skus),
      // Al cancelar, el listener global no refoca (el mask del confirmDialog
      // sigue presente durante su animación de salida), así que lo hacemos acá.
      reject: () => this.focusInputAuto(),
    });
  }

  private ejecutarActualizarPrecios(skus: string[]): void {
    this.actualizandoPrecios.set(true);
    this.api.lookupBulk(skus).subscribe({
      next: (frescos) => {
        this.actualizandoPrecios.set(false);
        const porSku = new Map(frescos.map((f) => [f.sku, f]));
        let actualizados = 0;
        let sinCambios = 0;
        let noEncontrados = 0;
        this.items.set(
          this.items().map((it) => {
            // Genéricos no se refrescan contra catálogo — su SKU es comodín y
            // el precio lo tipeó el operador.
            if (it.generico) return it;
            const f = porSku.get(it.sku);
            if (!f) {
              noEncontrados++;
              return it;
            }
            // Cuenta como cambio solo si cambia el PRECIO DE REFERENCIA que ve
            // el cliente (precioMostrado). Esto capta los cambios de rubro que
            // cruzan menaje↔maquinaria (que sí cambian el precio/perfil) pero
            // ignora los cambios de rubro cosméticos que dejan el mismo precio.
            const precioGuardado = this.precioMostrado(it);
            const precioActual = this.precioMostrado({
              pvpKtGastroConIva: f.pvpKtGastroConIva,
              pvpKtGastroSinIva: f.pvpKtGastroSinIva,
              porcIva: f.porcIva,
              rubro: f.rubro ?? it.rubro,
            });
            if (redondearMoneda(precioGuardado) === redondearMoneda(precioActual)) {
              sinCambios++;
              return it;
            }
            actualizados++;
            // Pisa SOLO precio/IVA/rubro; conserva cantidad, descuento, uid,
            // comentarios. Los totales y formas de pago son computed derivados
            // de estos campos → se recalculan solos.
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
        // Ya quedaron al día — el banner y los pills de "precio desactualizado"
        // dejan de tener sentido.
        this.cambiosPrecio.set(new Map());

        const partes: string[] = [
          `${actualizados} ${actualizados === 1 ? 'precio actualizado' : 'precios actualizados'}`,
        ];
        if (sinCambios > 0) {
          partes.push(`${sinCambios} sin ${sinCambios === 1 ? 'cambio' : 'cambios'}`);
        }
        if (noEncontrados > 0) {
          partes.push(`${noEncontrados} fuera de catálogo`);
        }
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

  /** Implementa {@link HasUnsavedChanges} para el {@link unsavedChangesGuard}.
   *  Solo bloquea la navegación cuando se está EDITANDO un presupuesto y
   *  hay cambios pendientes — durante la creación inicial el operador
   *  puede abandonar sin riesgo de perder un guardado. */
  hasUnsavedChanges(): boolean {
    return this.esModoEdicion() && this.hayCambiosSinGuardar();
  }

  // ============================================================
  // Refoco del scan (host) — el input y la búsqueda viven en `carrito-editor`;
  // el host solo decide CUÁNDO refocar tras SUS PROPIOS clicks/diálogos.
  // ============================================================
  /** Refoco automático "best-effort": respeta el guard táctil
   *  ({@link esTactil}) — lo usan el listener global de clicks y el cierre de
   *  los dialogs propios del host. El componente refoca directo (sin este
   *  guard) para su propio flujo de scan/búsqueda, porque la pistola debe
   *  alimentar el input también en tablets. */
  private focusInputAuto(): void {
    if (this.esTactil) return;
    this.buscador()?.focusScanInput();
  }

  /** True si hay algún dialog/overlay PROPIO DEL HOST abierto. En ese caso no
   *  robamos el foco hacia el scan que está detrás del overlay (el operador
   *  está trabajando dentro del dialog). Los dialogs propios de
   *  `carrito-editor` ("Producto genérico", "Ver producto") ya NO se chequean
   *  acá — el componente emite su propio output {@code dialogCerrado} cuando
   *  se cierra (ver {@link onCarritoDialogCerrado}). */
  private algunDialogAbierto(): boolean {
    return (
      this.mostrarDialogCliente() ||
      this.mostrarDialogCrearPedido()
    );
  }

  /** True si el elemento es un campo donde el operador podría estar tipeando
   *  (input/textarea/select/contenteditable) y por lo tanto NO debemos
   *  robarle el foco. El propio scan input es un input — devolverlo acá como
   *  "editable" es inocuo: ya tiene el foco, no hay nada que refocar. */
  private esCampoEditable(el: Element | null): boolean {
    if (!el) return false;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    return (el as HTMLElement).isContentEditable === true;
  }

  /** Precio de REFERENCIA unitario a mostrar para un producto en la lista/detalle:
   *  el precio con la forma de pago destacada según el rubro del ítem — mismo
   *  criterio que el scan/visor del showroom. Delega en el servicio compartido
   *  (única fuente, ver {@link PrecioPerfilService.precioMostrado}). */
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

  // ============================================================
  // carrito-editor — scan/búsqueda + tabla editable + "Producto genérico"
  // (agregar/editar/quitar/vaciar). Este host solo reacciona a lo que el
  // componente emite; la mutación real de `items` la hace el componente
  // (two-way model).
  // ============================================================
  /** Bumpea el tick propio (recalcula totales/formas) y replica el toast +
   *  `hayCambiosSinGuardar` con la MISMA data que ya usó el componente para
   *  su propio toast interno (no se re-emite acá para no duplicar avisos:
   *  el `MessageService` de esta app es un singleton compartido). */
  onCarritoMutacion(ev: CarritoMutacion): void {
    this.itemsTick.update((v) => v + 1);
    this.notificarMutacion(ev.severity, ev.summary, ev.detail);
  }

  /** Un dialog/overlay PROPIO de `carrito-editor` ("Producto genérico" o "Ver
   *  producto") se cerró por cualquier camino — replica el refoco que antes
   *  disparaba el effect unificado sobre `algunDialogAbierto()` (respeta el
   *  guard táctil). `vaciar()` ya no necesita este roundtrip: el componente
   *  se refoca a sí mismo de forma incondicional (scanInput vive ahí). */
  onCarritoDialogCerrado(): void {
    this.focusInputAuto();
  }

  // ============================================================
  // Sesión de cliente compartida (badge "Atendiendo a X")
  // ============================================================
  abrirDialogoNuevoCliente(): void {
    this.nombreNuevoCliente.set('');
    this.mostrarDialogoNuevoCliente.set(true);
  }


  /** Inicia una sesión nueva con el nombre tipeado, vía el servicio compartido
   *  (cierra la sesión anterior del operador y vacía su carrito del showroom).
   *  El prellenado del nombre del presupuesto lo hace el effect de la sesión;
   *  acá lo forzamos porque el operador lo eligió explícitamente. */
  confirmarNuevoCliente(): void {
    const nombre = this.nombreNuevoCliente().trim();
    if (!nombre) {
      this.warn('Cargá el nombre del cliente.');
      return;
    }
    this.iniciandoSesion.set(true);
    this.sesionService.iniciar(nombre).subscribe({
      next: () => {
        this.iniciandoSesion.set(false);
        this.mostrarDialogoNuevoCliente.set(false);
        this.clienteNombre.set(nombre);
      },
      error: (err) => {
        this.iniciandoSesion.set(false);
        toastError(this.toast, 'Nuevo cliente', err, 'No se pudo iniciar la sesión.');
      },
    });
  }

  /** Finaliza la atención actual vía el servicio compartido. Igual que en el
   *  showroom: cierra la sesión y vacía el carrito del showroom. NO borra el
   *  armado del presupuesto. */
  finalizarSesion(): void {
    if (!this.haySesionActiva()) return;
    this.confirmationService.confirm({
      header: '¿Finalizar atención?',
      message: 'Se cierra la sesión del cliente actual (también vacía el carrito '
        + 'del showroom). El armado del presupuesto NO se borra. ¿Continuás?',
      icon: 'pi pi-sign-out',
      acceptButtonProps: { label: 'Finalizar', icon: 'pi pi-check' },
      rejectButtonProps: { label: 'Cancelar', severity: 'secondary', outlined: true },
      accept: () => {
        this.sesionService.cancelar().subscribe({
          error: (err) => toastError(this.toast, 'Finalizar atención', err,
            'No se pudo finalizar la sesión.'),
        });
      },
      reject: () => this.focusInputAuto(),
    });
  }

  // ============================================================
  // Visor de presupuesto — QR + snapshot en vivo
  // ============================================================
  /** Abre el dialog del QR y genera el código que apunta al visor de
   *  presupuesto del operador logueado. Reusa `VisorConfig.baseUrl` (config del
   *  showroom) para resolver el host accesible desde el celular. */
  async abrirDialogVisor(): Promise<void> {
    this.mostrarDialogVisor.set(true);
    if (typeof window === 'undefined') {
      this.qrVisorDataUrl.set(null);
      return;
    }
    this.qrVisorGenerando.set(true);
    const tk = await firstValueFrom(this.api.obtenerVisorToken());
    if (!tk.token) {
      this.visorToken.set(null);
      this.qrVisorDataUrl.set(null);
      this.qrVisorGenerando.set(false);
      toastError(this.toast, 'Visor', null, 'Iniciá una atención (Nuevo cliente) para mostrar el visor.');
      this.mostrarDialogVisor.set(false);
      return;
    }
    this.visorToken.set(tk.token);
    try {
      const cfg = await firstValueFrom(this.api.obtenerVisorConfig());
      this.visorBaseConfig.set(cfg.baseUrl ?? '');
    } catch {
      this.visorBaseConfig.set('');
    }
    this.qrVisorDataUrl.set(await generarQrDataUrl(this.visorUrl()));
    this.qrVisorGenerando.set(false);
  }

  /** Arma el snapshot del armado para el visor read-only. Vista AGREGADA
   *  siempre (ítems + total + formas globales), aunque el modo de cotización
   *  esté en individual. */
  private armarSnapshotVisor(): PresupuestoVisor {
    const items = this.items().map((it) => ({
      sku: it.sku,
      descripcion: it.descripcion ?? null,
      imagenUrl: it.imagenUrl ?? null,
      cantidad: it.cantidad,
      precioUnitario: redondearMoneda(this.precioMostrado(it)),
      descuentoPorcentaje: it.descuentoPorcentaje ?? 0,
      subtotalLinea: redondearMoneda(this.totalLinea(it)),
    }));
    const formasPago = this.formasPagoFooter().map((f) => ({
      id: f.id,
      nombre: f.nombre,
      precioFinal: f.precioFinal ?? 0,
      cantidadCuotas: f.cantidadCuotas ?? null,
      esMejorPrecio: f.esMejorPrecio,
    }));
    return {
      clienteNombre: this.clienteNombre().trim() || null,
      items,
      total: redondearMoneda(this.totalReferencia()),
      formasPago,
    };
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
    // El input MUESTRA el % efectivo (un reflejo del promedio). Al enfocar y
    // desenfocar SIN tipear, p-inputNumber re-emite ese valor; si lo aplicáramos,
    // copiaríamos el promedio a cada ítem y aplastaríamos los descuentos
    // individuales distintos (ej. 3,7% + 5% → 4,4% + 4,4%). Si el valor entrante
    // coincide (±0,005, la tolerancia del redondeo a 2 decimales del input) con
    // el % efectivo actual, no hubo un cambio real del operador → no tocamos nada.
    if (Math.abs(valor - this.descuentoGlobal()) < 0.005) return;
    const todosIguales = actuales.every((it) => (it.descuentoPorcentaje ?? 0) === valor);
    if (todosIguales) return;
    for (const it of actuales) it.descuentoPorcentaje = valor;
    this.itemsTick.update((v) => v + 1);
    this.notificarMutacion('info', 'Descuento global aplicado',
      `${valor}% sobre ${actuales.length} ${actuales.length === 1 ? 'ítem' : 'ítems'}.`);
  }

  /** Clase del input "Descuento global" — mismo criterio de color, a nivel
   *  presupuesto (según el % efectivo). */
  claseInputDescuentoGlobal(): string {
    const base = 'text-center descuento-input';
    return this.descuentoGlobal() > 0
      ? `${base} font-semibold text-sky-600 dark:text-sky-400`
      : `${base} text-muted-color`;
  }

  /** Selecciona el contenido del input al enfocarlo (el "0%" no se concatena al
   *  tipear). Lógica compartida en {@link seleccionarTextoAlEnfocar}. */
  protected readonly seleccionarAlEnfocar = seleccionarTextoAlEnfocar;

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
      // Congela el perfil de IVA con que se cotizó (menaje c/IVA, maquinaria
      // s/IVA) para que el pedido facture igual sin re-deducirlo.
      precioReferenciaConIva: this.precioPerfil.precioReferenciaConIva(it),
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
      // Solo en agregado: en individual el id no aplica.
      formaPagoSeleccionadaId: individual ? null : this.formaPagoSeleccionadaId(),
      items,
      formasPago,
      origenAtencionSesionId: this.origenAtencionSesionId(),
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
      this.warn('Agregá al menos un producto para previsualizar.');
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
        // El backend ya evaluó (y, si correspondía, cerró) la sesión de origen
        // al procesar este request, haya o no devuelto un PDF — limpiamos el
        // flag acá (antes del posible return de más abajo) para que un
        // reintento no reenvíe un origenAtencionSesionId sobre una sesión que
        // ya se procesó.
        this.origenAtencionSesionId.set(null);
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
        // Un presupuesto NUEVO se persiste al generar el PDF: el backend
        // devuelve su número en el header. Lo tomamos para pasar a "modo
        // edición" de ese presupuesto → habilita el botón "Crear pedido" y
        // hace que una nueva generación ACTUALICE este presupuesto en vez de
        // crear un duplicado.
        if (editandoId == null) {
          const nuevoId = Number(res.headers.get('X-Presupuesto-Id'));
          if (Number.isFinite(nuevoId) && nuevoId > 0) {
            this.presupuestoEditandoId.set(nuevoId);
          }
        }
        // Si el presupuesto ya tenía pedido, ahora quedó "editado tras
        // convertir" → reflejamos la nueva fecha de modificación en memoria
        // para habilitar el botón "Regenerar pedido" sin recargar.
        if (editandoId != null && this.pedidoIdConvertido() != null) {
          this.modificadoAtPresupuesto.set(new Date().toISOString());
        }
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
      this.warn('Agregá al menos un producto para enviar.');
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
        this.origenAtencionSesionId.set(null);
        // Igual que en ejecutarPrevisualizar: un presupuesto NUEVO también se
        // persiste al enviarlo por email, así que pasamos a "modo edición" de
        // ese presupuesto. Sin esto, un segundo envío/generación crearía un
        // DUPLICADO y el botón "Crear pedido" (que exige esModoEdicion) quedaría
        // deshabilitado hasta recargar la página.
        if (editandoId == null) {
          if (Number.isFinite(res.presupuestoId) && res.presupuestoId > 0) {
            this.presupuestoEditandoId.set(res.presupuestoId);
          }
        }
        // Si ya tenía pedido y se editó al reenviarlo, reflejamos la nueva fecha
        // de modificación en memoria para habilitar "Regenerar pedido" sin
        // recargar (mismo criterio que ejecutarPrevisualizar).
        if (editandoId != null && this.pedidoIdConvertido() != null) {
          this.modificadoAtPresupuesto.set(new Date().toISOString());
        }
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
    const nombre = this.clienteNombre().trim();
    if (!nombre) {
      this.warn('Falta el nombre del cliente.');
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

  /** Ícono PrimeNG para una forma de pago (mismo criterio que el showroom). */
  iconoForma(nombre: string | null | undefined): string {
    return iconoFormaReferencia(nombre);
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
