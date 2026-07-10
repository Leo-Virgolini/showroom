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
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { MessageService } from 'primeng/api';
import { AutoCompleteCompleteEvent, AutoCompleteModule } from 'primeng/autocomplete';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { InputMaskModule } from 'primeng/inputmask';
import { InputTextModule } from 'primeng/inputtext';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { SelectModule } from 'primeng/select';
import { TextareaModule } from 'primeng/textarea';
import { TooltipModule } from 'primeng/tooltip';
import {
  CategoriaFiscal,
  ClienteAutocompletar,
  CrearPedidoRequest,
  FormaPago,
  Localidad,
  Provincia,
  OPCIONES_RUBRO_CLIENTE,
} from '../models';
import { PrecioPerfilService } from '../precio-perfil.service';
import { ShowroomService } from '../showroom.service';
import { toastError } from '../toast.utils';
import { calcularSugerenciasEmail } from '../email-suggestions.utils';
import { perfilForma, precioPorForma, iconoFormaReferencia, redondearMoneda } from '../precio-referencia.util';
import { BackendStatusService } from '../backend-status.service';

/** Ítem de pedido provisto directamente al modal (flujo showroom, desde el
 *  carrito). Misma forma que los ítems que el modal deriva de un presupuesto. */
export interface PedidoItemEntrada {
  sku: string;
  cantidad: number;
  precioConIva: number | null;
  porcIva: number | null;
  descuentoPorcentaje: number | null;
  rubro: string | null;
  comentarios: string | null;
}

/** Pre-llenado opcional del formulario de cliente (showroom: datos de la sesión
 *  de atención + forma de pago elegida en el carrito). */
export interface PedidoClientePrefill {
  nombre?: string | null;
  razonSocial?: string | null;
  telefono?: string | null;
  email?: string | null;
  nroDoc?: number | null;
  rubro?: string | null;
  formaPagoId?: number | null;
}

/**
 * Dialog único de creación de pedido en DUX. Se usa en dos flujos:
 *   - Desde un presupuesto guardado ({@code /presupuestos/historial} y
 *     {@code /presupuestos/editar/:id}): se pasa {@link presupuestoId} y el
 *     modal carga el detalle solo. Al confirmar marca el presupuesto como
 *     convertido (o regenera si hay {@link pedidoAnteriorId}).
 *   - Desde el showroom: el padre pasa {@link items} (derivados del carrito) +
 *     {@link clientePrefill} + {@code origenPresupuesto=false}. El modal no
 *     carga ningún presupuesto; al confirmar crea el pedido y emite el
 *     resultado para que el showroom haga sus pasos (vaciar carrito, reseña).
 *
 * <p>Inputs:
 *   - {@link visible}: control bidireccional del dialog.
 *   - {@link presupuestoId}: id del presupuesto a convertir. Al cambiar y
 *     `visible=true`, el dialog carga el detalle del presupuesto y pre-llena
 *     el form con los datos del cliente.
 *
 * <p>Outputs:
 *   - {@link pedidoCreado}: emite cuando se creó el pedido OK y se marcó el
 *     presupuesto como convertido. Permite al padre actualizar su listado
 *     o navegar a la vista de pedidos.
 *
 * <p>El dialog encapsula:
 *   - Carga lazy de catálogos (provincias, localidades, formas de pago).
 *   - Validación de campos obligatorios (CUIT 11 dígitos, nombre, email,
 *     teléfono, rubro).
 *   - POST a `/pedido-dux` + marcar el presupuesto como convertido.
 *   - Manejo de errores y casos borde (pedido creado sin id, marcado falló).
 *
 * <p>Los items + precios se toman del DETALLE PERSISTIDO del presupuesto, no
 * de cambios en memoria. Si el operador editó el presupuesto sin guardar,
 * el pedido se va a crear con la versión guardada — el padre tiene que
 * obligar a guardar antes de abrir el dialog (en historial nunca hay
 * cambios pendientes; en /editar el botón se deshabilita cuando los hay).
 */
@Component({
  selector: 'app-crear-pedido-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    FormsModule,
    AutoCompleteModule,
    ButtonModule,
    DialogModule,
    InputMaskModule,
    InputTextModule,
    ProgressSpinnerModule,
    SelectModule,
    TextareaModule,
    TooltipModule,
  ],
  templateUrl: './crear-pedido-dialog.html',
  styleUrl: './crear-pedido-dialog.scss',
})
export class CrearPedidoDialog {
  private readonly api = inject(ShowroomService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly precioPerfil = inject(PrecioPerfilService);
  private readonly backendStatus = inject(BackendStatusService);

  // ----------- Inputs / Outputs -----------
  /** Control bidireccional del dialog. Cuando pasa de false→true con un
   *  {@link presupuestoId} válido, el dialog carga el detalle. */
  readonly visible = model<boolean>(false);
  /** Id del presupuesto a transformar. Null cierra/oculta el dialog. */
  readonly presupuestoId = input<number | null>(null);
  /** Id del pedido ANTERIOR cuando el dialog se abre en modo "regenerar"
   *  (el presupuesto ya estaba convertido y se editó). Null = alta normal.
   *  En modo regeneración: se pre-llenan CUIT/dirección/forma desde este
   *  pedido, y al confirmar se llama al endpoint de regeneración (que anula
   *  el viejo y re-vincula el presupuesto). */
  readonly pedidoAnteriorId = input<number | null>(null);
  /** Ítems del pedido provistos por el padre (flujo showroom). Cuando es no-null
   *  y no hay {@link presupuestoId}, el modal usa estos ítems en vez de cargar
   *  un presupuesto. */
  readonly itemsInput = input<PedidoItemEntrada[] | null>(null, { alias: 'items' });
  /** Pre-llenado del formulario de cliente (showroom: datos de la sesión). */
  readonly clientePrefill = input<PedidoClientePrefill | null>(null);
  /** Marca el origen del pedido para el backend: true (presupuesto) no consume
   *  la sesión de atención; false (showroom) sí la consume. */
  readonly origenPresupuesto = input<boolean>(true);
  /** Emite cuando se creó/regeneró el pedido OK. {@code presupuestoId} es null
   *  en el flujo showroom (no hay presupuesto que vincular). */
  readonly pedidoCreado = output<{ presupuestoId: number | null; pedidoLocalId: number }>();

  /** True cuando el dialog está en modo regeneración (hay un pedido anterior). */
  readonly esRegeneracion = computed(() => this.pedidoAnteriorId() != null);
  /** True si el pedido anterior llegó a DUX (estado ENVIADO) — entonces hay un
   *  comprobante que el operador debe cancelar a mano en DUX. Si fue ERROR/local,
   *  no hay nada que cancelar y se omite ese aviso. */
  readonly pedidoAnteriorEnviadoADux = signal(false);

  // ----------- Estado interno -----------
  readonly cargandoDetallePresupuesto = signal(false);
  readonly enviandoPedido = signal(false);

  /** Ítems cuyo precio de lista actual (cache) difiere del snapshot guardado en
   *  el presupuesto. Solo informativo — el pedido sigue usando el precio
   *  cotizado; el aviso deja que el operador decida crear igual o rehacerlo. */
  readonly cambiosPrecio = signal<{
    sku: string;
    descripcion: string;
    precioViejo: number;
    precioNuevo: number;
    deltaPct: number;
  }[]>([]);

  /** Items del detalle cargado — base para armar el payload + para calcular
   *  totales por forma de pago en el select. {@code comentarios} se preserva
   *  para forwardear al payload DUX (relevante en items genéricos). */
  readonly itemsDelPresupuesto = signal<{
    sku: string;
    cantidad: number;
    precioConIva: number | null;
    porcIva: number | null;
    descuentoPorcentaje: number | null;
    /** Rubro del ítem — define el perfil (menaje/maquinaria) con que se calcula
     *  el precio por forma de pago, igual que en scan/visor/presupuestador. */
    rubro: string | null;
    comentarios: string | null;
    /** Perfil de IVA con que se cotizó el ítem; el backend lo usa para congelar
     *  el perfil al crear el pedido. */
    precioReferenciaConIva: boolean | null;
  }[]>([]);

  // Datos del cliente — pre-llenados desde el presupuesto, editables.
  /** Razón social / apellido que va a DUX como `apellido_razon_social`. Antes
   *  era un placeholder fijo ("PRESUPUESTO"); ahora es editable. Se pre-llena
   *  con el nombre del presupuesto y lo puede completar/corregir el operador o
   *  el autocompletado por CUIT/razón social. */
  readonly pedidoRazonSocial = signal('');
  readonly pedidoNombre = signal('');
  readonly pedidoTelefono = signal('');
  readonly pedidoEmail = signal('');
  readonly pedidoCuit = signal<number | null>(null);
  readonly pedidoRubro = signal<string | null>(null);
  readonly pedidoRubroOtros = signal('');
  readonly pedidoDomicilio = signal('');
  readonly pedidoCodigoProvincia = signal<string | null>(null);
  readonly pedidoIdLocalidad = signal<string | null>(null);
  readonly pedidoObservaciones = signal('');
  readonly pedidoFormaPagoId = signal<number | null>(null);
  readonly sugerenciasEmailPedido = signal<string[]>([]);

  // Catálogos
  readonly provinciasPedido = signal<Provincia[]>([]);
  readonly localidadesPedido = signal<Localidad[]>([]);
  readonly cargandoLocalidadesPedido = signal(false);
  readonly formasPagoActivas = this.precioPerfil.formasPago;
  private localidadesSub: Subscription | null = null;

  /** Opciones del dropdown de rubro (constante compartida con presupuestos). */
  readonly opcionesRubroPedido = OPCIONES_RUBRO_CLIENTE;

  /** Input de texto libre que aparece al elegir "Otros…" — para enfocarlo
   *  automáticamente cuando el usuario selecciona esa opción en el dropdown. */
  private readonly rubroOtrosInput =
    viewChild<ElementRef<HTMLInputElement>>('rubroOtrosInput');

  // Categoría fiscal del cliente — DUX la exige obligatoria. Editable; el default
  // CONSUMIDOR_FINAL preserva el comportamiento previo (antes era fija).
  readonly pedidoCategoriaFiscal = signal<CategoriaFiscal>('CONSUMIDOR_FINAL');
  readonly opcionesCategoriaFiscal: { label: string; value: CategoriaFiscal }[] = [
    { label: 'Consumidor Final', value: 'CONSUMIDOR_FINAL' },
    { label: 'Responsable Inscripto', value: 'RESPONSABLE_INSCRIPTO' },
    { label: 'Exento', value: 'EXENTO' },
    { label: 'Monotributista', value: 'MONOTRIBUTISTA' },
  ];

  // ----------- Totales por forma de pago -----------
  /** Ícono de la forma de pago — mismo criterio que scan/visor/showroom: si
   *  tiene cuotas usa la tarjeta, sino la heurística canónica por nombre. */
  iconoForma(forma: FormaPago): string {
    if (forma.cantidadCuotas && forma.cantidadCuotas > 1) return 'pi pi-credit-card';
    return iconoFormaReferencia(forma.nombre);
  }

  /** Total que paga el cliente con una forma — calculado POR ÍTEM con el perfil
   *  (menaje/maquinaria) de su rubro, usando la fórmula canónica `precioPorForma`
   *  (la misma de scan/visor/presupuestador y del backend al crear el pedido).
   *
   *  Antes esto usaba un subtotal global + `base / (1 − recargo)`, que (a) para
   *  recargos negativos no coincide con `× (1 − |r|)` y (b) aplicaba el recargo e
   *  IVA de menaje a TODOS los ítems, ignorando los de maquinaria (otro recargo,
   *  sin IVA). Eso hacía que el preview no coincidiera con el total real del
   *  pedido ni con el del presupuesto. */
  totalParaFormaPago(forma: FormaPago): number {
    return this.itemsDelPresupuesto().reduce((acc, it) => {
      const esMaq = this.precioPerfil.rubroCotizaSinIva(it.rubro);
      const precioU = precioPorForma(it.precioConIva ?? 0, it.porcIva, perfilForma(forma, esMaq));
      const factorDesc = 1 - (it.descuentoPorcentaje ?? 0) / 100;
      return acc + precioU * it.cantidad * factorDesc;
    }, 0);
  }

  // ----------- Validación -----------
  readonly puedeCrearPedido = computed(() => {
    const cuit = this.pedidoCuit();
    const cuitOk = cuit != null && String(cuit).length === 11;
    const emailOk = /^[^@\s,]+@[^@\s,]+\.[^@\s,]+$/.test(this.pedidoEmail().trim());
    const razonSocialOk = this.pedidoRazonSocial().trim().length > 0;
    const telOk = this.pedidoTelefono().trim().length > 0;
    const rubro = this.pedidoRubro();
    const rubroOk = !!rubro && (rubro !== 'otros' || this.pedidoRubroOtros().trim().length > 0);
    // Forma de pago obligatoria: el perfil de IVA por ítem (menaje c/IVA,
    // maquinaria s/IVA) depende de la forma, y sin ella el backend no puede
    // facturar a DUX con el criterio correcto.
    const formaOk = this.pedidoFormaPagoId() != null;
    return cuitOk && emailOk && razonSocialOk && telOk && rubroOk && formaOk
      && this.itemsDelPresupuesto().length > 0;
  });

  // ----------- Lifecycle: cargar detalle al abrir -----------
  constructor() {
    // Formas de pago activas — fuente compartida. Se cargan una vez; cuando
    // llegan (o cambian) re-evaluamos la forma elegida con el MISMO criterio que
    // cargarFormasPagoSiHaceFalta (primera activa si no hay elegida o si la
    // elegida ya no está activa). Leemos pedidoFormaPagoId en untracked para no
    // re-correr cuando el operador cambia la forma a mano.
    this.precioPerfil.cargar();
    effect(() => {
      this.formasPagoActivas();
      untracked(() => this.cargarFormasPagoSiHaceFalta());
    });

    // Cuando `visible` pasa a true con un `presupuestoId` válido, carga el
    // detalle del presupuesto y pre-llena el form. Effect garantiza que se
    // re-ejecute si el id cambia (caso teórico: el padre quiere reusar el
    // dialog para otro presupuesto sin desmontarlo).
    effect(() => {
      const v = this.visible();
      const id = this.presupuestoId();
      if (!v) return;
      if (id != null) {
        this.cargarDetalle(id);
        return;
      }
      // Flujo showroom: los ítems vienen de un computed del carrito. Los leemos
      // en untracked para inicializar SOLO al abrir el modal — si trackeáramos
      // `itemsInput()`, un cambio del carrito (p. ej. por SSE) mientras el modal
      // está abierto re-dispararía la inicialización y borraría lo que el
      // operador tipeó en el formulario.
      const items = untracked(() => this.itemsInput());
      if (items) {
        this.inicializarDesdeItems(items, untracked(() => this.clientePrefill()));
        // Editar pedido (sin presupuesto): completar CUIT/dirección/forma con
        // los datos del pedido que se está editando — igual que en el flujo de
        // regeneración desde presupuesto (cargarDetalle), pero acá no hay
        // presupuesto del que faltarían esos datos: viajan directo del pedido.
        const anteriorId = untracked(() => this.pedidoAnteriorId());
        if (anteriorId != null) this.prellenarDesdePedidoAnterior(anteriorId);
      }
    });
  }

  /** Inicializa el modal con ítems provistos por el padre (showroom), sin cargar
   *  ningún presupuesto. Pre-llena el cliente desde {@link clientePrefill} y deja
   *  el resto de los catálogos como en el flujo de presupuesto. */
  private inicializarDesdeItems(items: PedidoItemEntrada[], prefill: PedidoClientePrefill | null): void {
    this.cargandoDetallePresupuesto.set(false);
    this.cambiosPrecio.set([]);
    this.pedidoCategoriaFiscal.set('CONSUMIDOR_FINAL');
    this.clienteExistente.set(false);
    this.pedidoNombre.set(prefill?.nombre ?? '');
    this.pedidoRazonSocial.set(prefill?.razonSocial ?? '');
    this.pedidoTelefono.set(prefill?.telefono ?? '');
    this.pedidoEmail.set(prefill?.email ?? '');
    this.pedidoCuit.set(prefill?.nroDoc ?? null);
    this.pedidoObservaciones.set('');
    this.pedidoDomicilio.set('');
    this.pedidoCodigoProvincia.set(null);
    this.pedidoIdLocalidad.set(null);
    this.localidadesPedido.set([]);
    if (prefill?.rubro) {
      this.aplicarRubroPedido(prefill.rubro);
    } else {
      this.pedidoRubro.set(null);
      this.pedidoRubroOtros.set('');
    }
    this.pedidoFormaPagoId.set(prefill?.formaPagoId ?? null);
    this.itemsDelPresupuesto.set(items.map((it) => ({ ...it, precioReferenciaConIva: null })));
    this.cargarProvinciasSiHaceFalta();
    this.cargarFormasPagoSiHaceFalta();
    // Si el prefill trae un CUIT completo, intentamos reconocer al cliente y
    // completar los campos vacíos (mismo comportamiento que el flujo presupuesto).
    if (prefill?.nroDoc != null && String(prefill.nroDoc).length === 11) {
      this.autocompletarDesdeCuit(prefill.nroDoc);
    }
  }

  private cargarDetalle(id: number): void {
    this.cargandoDetallePresupuesto.set(true);
    this.cambiosPrecio.set([]);
    this.api.obtenerDetallePresupuestoComercial(id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (det) => {
        this.cargandoDetallePresupuesto.set(false);
        // El nombre cargado en el presupuesto es el nombre INFORMAL del cliente →
        // va al campo "Nombre y apellido" (opcional, ficha de cliente). La razón
        // social (formal, a DUX) arranca VACÍA: la completa el operador o la
        // precarga el autocompletado por CUIT/razón social. No se asume del
        // presupuesto (el presupuesto no tiene razón social).
        this.pedidoNombre.set(det.clienteNombre ?? '');
        this.pedidoRazonSocial.set('');
        this.clienteExistente.set(false);
        this.pedidoTelefono.set(det.clienteTelefono ?? '');
        this.pedidoEmail.set(det.clienteEmail ?? '');
        this.pedidoCuit.set(null); // no viene del presupuesto
        this.pedidoObservaciones.set(det.observaciones ?? '');
        const rubroGuardado = det.rubro ?? null;
        if (!rubroGuardado) {
          this.pedidoRubro.set(null);
          this.pedidoRubroOtros.set('');
        } else if (this.opcionesRubroPedido.some((o) => o.value === rubroGuardado)) {
          this.pedidoRubro.set(rubroGuardado);
          this.pedidoRubroOtros.set('');
        } else {
          this.pedidoRubro.set('otros');
          this.pedidoRubroOtros.set(rubroGuardado);
        }
        // Forma de pago: preseleccionamos la que tenía guardada el presupuesto
        // (null si era "Todas"). Si quedó null o la forma fue desactivada,
        // cargarFormasPagoSiHaceFalta() (más abajo) cae a la primera activa.
        this.pedidoFormaPagoId.set(det.formaPagoSeleccionadaId ?? null);
        // Defaults no derivados del presupuesto
        this.pedidoDomicilio.set('');
        this.pedidoCodigoProvincia.set(null);
        this.pedidoIdLocalidad.set(null);
        this.localidadesPedido.set([]);
        this.pedidoCategoriaFiscal.set('CONSUMIDOR_FINAL');

        this.itemsDelPresupuesto.set(det.items.map((it) => ({
          sku: it.sku,
          cantidad: it.cantidad,
          precioConIva: it.precioConIva,
          porcIva: it.porcIva,
          descuentoPorcentaje: it.descuentoPorcentaje,
          rubro: it.rubro ?? null,
          comentarios: it.comentarios ?? null,
          precioReferenciaConIva: it.precioReferenciaConIva ?? null,
        })));

        this.cargarProvinciasSiHaceFalta();
        this.cargarFormasPagoSiHaceFalta();
        this.verificarCambiosPrecio();

        // Modo regeneración: completar los datos que el presupuesto NO guarda
        // (CUIT, dirección, forma de pago) con los del pedido anterior.
        const anteriorId = this.pedidoAnteriorId();
        if (anteriorId != null) this.prellenarDesdePedidoAnterior(anteriorId);
      },
      error: (err) => {
        this.cargandoDetallePresupuesto.set(false);
        toastError(this.toast, 'Crear pedido', err,
          'No se pudo cargar el detalle del presupuesto.');
        // No podemos seguir sin el detalle — cerramos el dialog.
        this.visible.set(false);
      },
    });
  }

  /** Modo regeneración: trae el detalle del pedido anterior y pre-llena los
   *  campos que el presupuesto no conserva (CUIT, domicilio, provincia/localidad,
   *  forma de pago, observaciones). Best-effort: si falla, el operador completa
   *  a mano. También registra si el pedido anterior llegó a DUX, para decidir si
   *  mostrar el aviso de "cancelá el comprobante viejo a mano". */
  private prellenarDesdePedidoAnterior(pedidoId: number): void {
    this.pedidoAnteriorEnviadoADux.set(false);
    this.api.obtenerPedido(pedidoId).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (ped) => {
        this.pedidoAnteriorEnviadoADux.set(ped.estado === 'ENVIADO');
        if (ped.nroDoc != null) this.pedidoCuit.set(ped.nroDoc);
        if (ped.domicilio) this.pedidoDomicilio.set(ped.domicilio);
        // Forma de pago: solo rellenar con la del pedido anterior si NO se
        // eligió una antes (el editor pre-llena con la forma elegida en el
        // comparativo; el flujo presupuesto con la del presupuesto). Sin este
        // guard, este GET async pisaba la elección del operador con la forma
        // original y facturaba con la forma equivocada.
        if (ped.formaPagoId != null && this.pedidoFormaPagoId() == null) {
          this.pedidoFormaPagoId.set(ped.formaPagoId);
        }
        // Observaciones: solo si el presupuesto no traía las suyas (no pisar).
        if (ped.observaciones && !this.pedidoObservaciones().trim()) {
          this.pedidoObservaciones.set(ped.observaciones);
        }
        // Provincia → cargar sus localidades y recién ahí setear la localidad.
        if (ped.codigoProvincia) {
          this.pedidoCodigoProvincia.set(ped.codigoProvincia);
          this.cargandoLocalidadesPedido.set(true);
          this.localidadesSub?.unsubscribe();
          this.localidadesSub = this.api.obtenerLocalidades(ped.codigoProvincia)
            .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
            next: (lista) => {
              this.cargandoLocalidadesPedido.set(false);
              this.localidadesPedido.set(lista);
              if (ped.idLocalidad) this.pedidoIdLocalidad.set(ped.idLocalidad);
              this.localidadesSub = null;
            },
            error: () => {
              this.cargandoLocalidadesPedido.set(false);
              this.localidadesSub = null;
            },
          });
        }
      },
      error: () => {
        // Best-effort: sin los datos del pedido anterior el operador los completa.
      },
    });
  }

  /** Compara el precio snapshot de cada ítem contra el precio de lista ACTUAL
   *  del cache (lookup bulk, sin DUX → instantáneo) y publica las diferencias en
   *  {@link cambiosPrecio}. Excluye los ítems genéricos (su SKU es el comodín
   *  {@code dux.sku-producto-generico}, cuyo precio de catálogo no representa al
   *  producto real cargado a mano). Best-effort: si el lookup falla, no muestra
   *  nada (no bloquea la creación del pedido). */
  private verificarCambiosPrecio(): void {
    const skuGen = this.backendStatus.skuProductoGenerico();
    const items = this.itemsDelPresupuesto();
    const skus = items.filter((it) => it.sku !== skuGen).map((it) => it.sku);
    if (skus.length === 0) return;
    this.api.lookupBulk(skus).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (catalogo) => {
        const porSku = new Map(catalogo.map((c) => [c.sku, c]));
        const cambios = items.flatMap((it) => {
          if (it.sku === skuGen) return [];
          const actual = porSku.get(it.sku);
          const nuevo = actual?.pvpKtGastroConIva;
          if (nuevo == null || it.precioConIva == null) {
            return [];
          }
          // Redondeamos a moneda antes de comparar: sin esto, una diferencia de
          // sub-centavo por aritmética flotante dispara el banner "el precio
          // cambió" con dos montos que se ven idénticos. Mismo criterio que
          // editar-pedido-page.
          const nuevoR = redondearMoneda(nuevo);
          const viejoR = redondearMoneda(it.precioConIva);
          if (nuevoR === viejoR) {
            return [];
          }
          return [{
            sku: it.sku,
            descripcion: actual?.descripcion ?? it.sku,
            precioViejo: viejoR,
            precioNuevo: nuevoR,
            deltaPct: viejoR > 0
              ? ((nuevoR - viejoR) / viejoR) * 100
              : 0,
          }];
        });
        this.cambiosPrecio.set(cambios);
      },
      error: () => this.cambiosPrecio.set([]),
    });
  }

  private cargarProvinciasSiHaceFalta(): void {
    if (this.provinciasPedido().length > 0) return;
    this.api.obtenerProvincias().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (lista) => this.provinciasPedido.set(lista),
      error: (err) =>
        toastError(this.toast, 'Provincias', err, 'No se pudieron cargar las provincias'),
    });
  }

  /** Asegura una forma de pago válida elegida. Cae a la primera de las activas
   *  cuando no hay ninguna elegida O cuando la elegida no figura entre las
   *  activas (p. ej. la forma que tenía un presupuesto viejo fue desactivada y
   *  el select —que sólo lista activas— no podría mostrarla). Las formas las
   *  provee el servicio compartido (ya cargadas en el constructor). */
  private cargarFormasPagoSiHaceFalta(): void {
    const lista = this.formasPagoActivas();
    if (lista.length === 0) return;
    const id = this.pedidoFormaPagoId();
    if (id == null || !lista.some((f) => f.id === id)) {
      this.pedidoFormaPagoId.set(lista[0].id);
    }
  }

  cambiarProvinciaPedido(codigo: string | null): void {
    this.localidadesSub?.unsubscribe();
    this.localidadesSub = null;
    this.pedidoCodigoProvincia.set(codigo);
    this.pedidoIdLocalidad.set(null);
    this.localidadesPedido.set([]);
    if (!codigo) {
      this.cargandoLocalidadesPedido.set(false);
      return;
    }
    this.cargandoLocalidadesPedido.set(true);
    this.localidadesSub = this.api.obtenerLocalidades(codigo)
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (lista) => {
        this.cargandoLocalidadesPedido.set(false);
        this.localidadesPedido.set(lista);
        this.localidadesSub = null;
      },
      error: (err) => {
        this.cargandoLocalidadesPedido.set(false);
        this.localidadesSub = null;
        toastError(this.toast, 'Localidades', err,
          'No se pudieron cargar las localidades');
      },
    });
  }

  onCuitChangePedido(value: string | null | undefined): void {
    const digits = (value ?? '').replace(/\D/g, '');
    const nuevo = digits ? Number(digits) : null;
    const previo = this.pedidoCuit();
    this.pedidoCuit.set(nuevo);
    // Al cambiar el CUIT deja de estar confirmado como cliente existente.
    if (nuevo !== previo) this.clienteExistente.set(false);
    // Autocompletar al completar el CUIT (11 dígitos), solo en la transición a
    // un valor nuevo — evita disparar el lookup en cada tecla o al reabrir.
    if (digits.length === 11 && nuevo !== previo) {
      this.autocompletarDesdeCuit(nuevo!);
    }
  }

  /** Busca un cliente por CUIT y completa SOLO los campos vacíos del formulario
   *  (no pisa lo que el operador tipeó ni lo que vino del presupuesto). */
  private autocompletarDesdeCuit(nroDoc: number): void {
    this.api.buscarClientePorCuit(nroDoc).pipe(takeUntilDestroyed(this.destroyRef)).subscribe((cli) => {
      if (!cli) return;
      if (this.completarDesdeCliente(cli) > 0) {
        this.toast.add({
          severity: 'info',
          summary: 'Cliente reconocido',
          detail: 'Completé los datos desde un cliente guardado.',
          life: 4000,
        });
      }
    });
  }

  /** Completa SOLO los campos vacíos del formulario desde un cliente guardado.
   *  Reutilizado por el autocompletado por CUIT y por razón social. Devuelve la
   *  cantidad de campos completados. */
  private completarDesdeCliente(cli: ClienteAutocompletar): number {
    // Se reconoció un cliente guardado (por CUIT o razón social).
    this.clienteExistente.set(true);
    let completados = 0;
    if (cli.razonSocial && !this.pedidoRazonSocial().trim()) { this.pedidoRazonSocial.set(cli.razonSocial); completados++; }
    if (cli.nombre && !this.pedidoNombre().trim()) { this.pedidoNombre.set(cli.nombre); completados++; }
    if (cli.email && !this.pedidoEmail().trim()) { this.pedidoEmail.set(cli.email); completados++; }
    if (cli.telefono && !this.pedidoTelefono().trim()) { this.pedidoTelefono.set(cli.telefono); completados++; }
    if (cli.nroDoc != null && this.pedidoCuit() == null) { this.pedidoCuit.set(cli.nroDoc); completados++; }
    if (cli.rubro && !this.pedidoRubro()) { this.aplicarRubroPedido(cli.rubro); completados++; }
    if (cli.domicilio && !this.pedidoDomicilio().trim()) { this.pedidoDomicilio.set(cli.domicilio); completados++; }
    // Provincia/localidad: solo si la provincia está vacía (sino respetamos lo
    // ya elegido). Al setear la provincia cargamos sus localidades y recién ahí
    // completamos la localidad.
    if (cli.codigoProvincia && !this.pedidoCodigoProvincia()) {
      this.pedidoCodigoProvincia.set(cli.codigoProvincia);
      completados++;
      this.cargarLocalidadesYCompletar(cli.codigoProvincia, cli.idLocalidad ?? null);
    }
    return completados;
  }

  /** True cuando el CUIT/razón social corresponden a un cliente ya guardado
   *  (reconocido por el autocompletado). Se muestra como badge en el diálogo. */
  readonly clienteExistente = signal(false);

  /** Sugerencias del autocomplete por razón social (clientes guardados). */
  readonly sugerenciasRazonSocial = signal<ClienteAutocompletar[]>([]);

  /** completeMethod del p-autoComplete de razón social: busca clientes guardados
   *  cuyo razón social/nombre coincida con lo tipeado. */
  buscarSugerenciasRazonSocial(event: { query: string }): void {
    const q = (event.query ?? '').trim();
    if (q.length < 2) { this.sugerenciasRazonSocial.set([]); return; }
    this.api.buscarClientesPorRazonSocial(q).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((lista) => this.sugerenciasRazonSocial.set(lista));
  }

  /** ngModelChange del p-autoComplete de razón social. Si llega un objeto, el
   *  operador eligió una sugerencia → completamos el resto y fijamos la razón
   *  social; si llega un string, es texto libre. */
  onRazonSocialChange(value: string | ClienteAutocompletar): void {
    if (value && typeof value === 'object') {
      this.pedidoRazonSocial.set(value.razonSocial ?? value.nombre ?? '');
      const completados = this.completarDesdeCliente(value);
      if (completados > 0) {
        this.toast.add({
          severity: 'info',
          summary: 'Cliente reconocido',
          detail: 'Completé los datos desde un cliente guardado.',
          life: 4000,
        });
      }
    } else {
      this.pedidoRazonSocial.set(value ?? '');
    }
  }

  /** Handler del dropdown de rubro. Setea el signal y, cuando el usuario elige
   *  "Otros…" manualmente, enfoca el input de texto libre que recién se monta
   *  (esperamos un tick a que el `@if` lo renderice). Solo corre por interacción
   *  del usuario; el prefill/hidratación setea el signal por código y no dispara
   *  este handler, así que no le roba el foco. */
  onRubroPedidoSelect(rubro: string | null): void {
    this.pedidoRubro.set(rubro);
    if (rubro === 'otros') {
      setTimeout(() => this.rubroOtrosInput()?.nativeElement.focus(), 0);
    }
  }

  /** Aplica un rubro guardado al select: si coincide con una opción predefinida
   *  la selecciona; sino usa "Otros…" + el texto libre. */
  private aplicarRubroPedido(rubro: string): void {
    if (this.opcionesRubroPedido.some((o) => o.value === rubro)) {
      this.pedidoRubro.set(rubro);
      this.pedidoRubroOtros.set('');
    } else {
      this.pedidoRubro.set('otros');
      this.pedidoRubroOtros.set(rubro);
    }
  }

  /** Carga las localidades de una provincia y completa la localidad SOLO si
   *  todavía está vacía (autocompletado no destructivo). */
  private cargarLocalidadesYCompletar(codigoProvincia: string, idLocalidad: string | null): void {
    this.cargandoLocalidadesPedido.set(true);
    this.localidadesSub?.unsubscribe();
    this.localidadesSub = this.api.obtenerLocalidades(codigoProvincia)
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (lista) => {
        this.cargandoLocalidadesPedido.set(false);
        this.localidadesPedido.set(lista);
        if (idLocalidad && !this.pedidoIdLocalidad()) this.pedidoIdLocalidad.set(idLocalidad);
        this.localidadesSub = null;
      },
      error: () => {
        this.cargandoLocalidadesPedido.set(false);
        this.localidadesSub = null;
      },
    });
  }

  onTelefonoChangePedido(value: string | null | undefined): void {
    this.pedidoTelefono.set(value ?? '');
  }

  readonly cuitInputValuePedido = computed(() => {
    const n = this.pedidoCuit();
    return n != null ? String(n) : '';
  });

  readonly telefonoInputValuePedido = computed(() => {
    const t = this.pedidoTelefono();
    return t ? t.replace(/\D/g, '') : '';
  });

  private rubroFinalPedido(): string {
    const r = this.pedidoRubro();
    if (r === 'otros') return this.pedidoRubroOtros().trim();
    return r ?? '';
  }

  confirmarCrearPedido(): void {
    if (!this.puedeCrearPedido()) {
      this.toast.add({
        severity: 'warn',
        summary: 'Faltan datos',
        detail: 'Razón social, CUIT 11 dígitos, teléfono, email, rubro y forma de pago son obligatorios.',
        life: 4000,
      });
      return;
    }
    const presupuestoId = this.presupuestoId();
    // Sin presupuesto Y sin ítems provistos no hay nada que crear.
    if (presupuestoId == null && this.itemsInput() == null) return;

    const cuit = this.pedidoCuit()!;
    const req: CrearPedidoRequest = {
      apellidoRazonSocial: this.pedidoRazonSocial().trim(),
      // `nombre` (opcional): NO se sube a DUX (el backend lo omite); se guarda en
      // la ficha del cliente (columna nombre). Puede ir vacío.
      nombre: this.pedidoNombre().trim() || undefined,
      categoriaFiscal: this.pedidoCategoriaFiscal(),
      tipoDoc: 'CUIT',
      nroDoc: cuit,
      telefono: this.pedidoTelefono().trim(),
      email: this.pedidoEmail().trim(),
      rubro: this.rubroFinalPedido(),
      domicilio: this.pedidoDomicilio().trim() || undefined,
      codigoProvincia: this.pedidoCodigoProvincia() ?? undefined,
      idLocalidad: this.pedidoIdLocalidad() ?? undefined,
      observaciones: this.pedidoObservaciones().trim() || undefined,
      formaPagoId: this.pedidoFormaPagoId() ?? undefined,
      // Origen: presupuesto (true) no consume la sesión de atención; showroom
      // (false) sí la consume. Lo decide el padre vía input.
      origenPresupuesto: this.origenPresupuesto(),
      items: this.itemsDelPresupuesto().map((it) => ({
        sku: it.sku,
        cantidad: it.cantidad,
        precioUnitario: it.precioConIva ?? null,
        // Rubro del presupuesto: el backend lo usa (sin caer al cache) para
        // reproducir el perfil (menaje/maquinaria) con que se cotizó cada ítem y
        // resolver el recargo de la forma de pago elegida.
        rubro: it.rubro ?? undefined,
        descuentoPorcentaje: it.descuentoPorcentaje ?? undefined,
        // porcIva: relevante solo para items genéricos (el backend usa el
        // del cache para items normales). Lo forwardeamos siempre cuando
        // está presente — no estorba para items normales.
        porcIva: it.porcIva ?? undefined,
        // Comentarios: viaja al campo `comentarios` de la línea en el
        // payload DUX. Para items normales es null; para genéricos es la
        // descripción tipeada por el operador en el presupuesto.
        comentarios: it.comentarios ?? undefined,
        precioReferenciaConIva: it.precioReferenciaConIva ?? undefined,
      })),
    };

    const esRegen = this.esRegeneracion();
    const pedidoEditarId = this.pedidoAnteriorId();
    this.enviandoPedido.set(true);
    // Tres variantes:
    //  - Regen desde presupuesto: el backend crea el nuevo pedido, anula el
    //    viejo y re-vincula el presupuesto en una sola operación.
    //  - Editar pedido (sin presupuesto): mismo mecanismo de regeneración pero
    //    contra el pedido directamente, sin presupuesto que re-vincular.
    //  - Alta normal: crea y luego marcamos (si viene de un presupuesto).
    const envio$ =
      presupuestoId != null
        ? this.api.regenerarPedido(presupuestoId, req)
        : pedidoEditarId != null
          ? this.api.regenerarPedidoDesdePedido(pedidoEditarId, req)
          : this.api.crearPedido(req);
    envio$.subscribe({
      next: (res) => {
        this.enviandoPedido.set(false);
        if (res.estado === 'ENVIADO') {
          // Flujo showroom: el pedido se creó en DUX y no hay presupuesto que
          // vincular. NO dependemos de pedidoLocalId (el padre solo vacía el
          // carrito y muestra la reseña), así que emitimos igual aunque DUX no
          // haya devuelto el id local — sino el carrito quedaría sin vaciar y se
          // podría re-enviar/duplicar. Va ANTES del chequeo de pedidoLocalId.
          if (presupuestoId == null) {
            if (this.pedidoAnteriorId() == null) {
              this.toast.add({
                severity: 'success',
                summary: 'Pedido cargado en DUX',
                detail: res.mensaje ?? 'El pedido se creó en DUX.',
                life: 5000,
              });
            }
            this.visible.set(false);
            this.pedidoCreado.emit({ presupuestoId: null, pedidoLocalId: res.pedidoLocalId ?? 0 });
            return;
          }
          if (res.pedidoLocalId == null) {
            this.toast.add({
              severity: 'warn',
              summary: 'Pedido creado pero sin id',
              detail: `Pedido enviado a DUX OK pero no recibimos pedidoLocalId. ` +
                `Marca manualmente el presupuesto #${presupuestoId} desde la base.`,
              life: 10000,
            });
            this.visible.set(false);
            return;
          }
          const pedidoLocalId = res.pedidoLocalId;
          if (esRegen) {
            // El backend ya anuló el pedido viejo y re-vinculó el presupuesto;
            // no hay que marcar la conversión aparte.
            const anteriorId = this.pedidoAnteriorId();
            const avisoDux = this.pedidoAnteriorEnviadoADux()
              ? ` Acordate de CANCELAR a mano el comprobante del pedido #${anteriorId} en DUX (la API de DUX no permite anularlo).`
              : '';
            this.toast.add({
              severity: 'success',
              summary: 'Pedido regenerado',
              detail: `Presupuesto #${presupuestoId} → nuevo Pedido #${pedidoLocalId}. ` +
                `El pedido anterior #${anteriorId} quedó anulado.` + avisoDux,
              life: avisoDux ? 12000 : 6000,
            });
            this.visible.set(false);
            this.pedidoCreado.emit({ presupuestoId, pedidoLocalId });
            return;
          }
          this.api.marcarPresupuestoConvertido(presupuestoId, pedidoLocalId).subscribe({
            next: () => {
              this.toast.add({
                severity: 'success',
                summary: 'Pedido cargado en DUX',
                detail: `Presupuesto #${presupuestoId} → Pedido #${pedidoLocalId}`,
                life: 6000,
              });
              this.visible.set(false);
              this.pedidoCreado.emit({ presupuestoId, pedidoLocalId });
            },
            error: (err) => {
              console.warn('[marcar-convertido] falló:', err);
              this.toast.add({
                severity: 'warn',
                summary: 'Pedido creado pero no quedó vinculado',
                detail: `Pedido #${pedidoLocalId} creado OK en DUX. ` +
                  `No se pudo marcar el presupuesto #${presupuestoId} como convertido — ` +
                  `ya NO lo vuelvas a transformar para no duplicar.`,
                life: 12000,
              });
              this.visible.set(false);
              // Igual emitimos: el padre puede recargar el listado y va a
              // ver el pedido. Solo se perdió el vínculo bidireccional.
              this.pedidoCreado.emit({ presupuestoId, pedidoLocalId });
            },
          });
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
        this.enviandoPedido.set(false);
        toastError(this.toast, esRegen ? 'Regenerar pedido' : 'Crear pedido', err,
          'Error al enviar el pedido a DUX.');
      },
    });
  }

  onCompletarEmailPedido(event: AutoCompleteCompleteEvent): void {
    this.sugerenciasEmailPedido.set(calcularSugerenciasEmail(event.query));
  }

  onCerrarDialog(): void {
    // Cancelar carga de localidades pendiente para evitar emit fantasma cuando
    // el operador cierra antes de que termine el GET.
    this.localidadesSub?.unsubscribe();
    this.localidadesSub = null;
  }
}
