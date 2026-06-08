import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  model,
  output,
  signal,
  untracked,
} from '@angular/core';
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
  CrearPedidoRequest,
  FormaPago,
  Localidad,
  Provincia,
} from '../models';
import { PrecioPerfilService } from '../precio-perfil.service';
import { ShowroomService } from '../showroom.service';
import { toastError } from '../toast.utils';
import { calcularSugerenciasEmail } from '../email-suggestions.utils';
import { perfilForma, precioPorForma } from '../precio-referencia.util';

/** Placeholder fijo que DUX recibe como apellido/razón social cuando el
 *  pedido se crea a partir de un presupuesto. Distinto del placeholder del
 *  flujo de scan/carrito ("PEDIDO SHOWROOM") para que la operadora distinga
 *  el origen del comprobante en DUX y reemplace por el cliente real al editar. */
const APELLIDO_RAZON_SOCIAL = 'PRESUPUESTO';

/**
 * Dialog reusable para transformar un presupuesto comercial en un pedido en
 * DUX. Se usa desde {@code /presupuestos/historial} (acción por fila) y
 * desde {@code /presupuestos/editar/:id} (botón del toolbar en modo edición).
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
})
export class CrearPedidoDialog {
  private readonly api = inject(ShowroomService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly precioPerfil = inject(PrecioPerfilService);

  // ----------- Inputs / Outputs -----------
  /** Control bidireccional del dialog. Cuando pasa de false→true con un
   *  {@link presupuestoId} válido, el dialog carga el detalle. */
  readonly visible = model<boolean>(false);
  /** Id del presupuesto a transformar. Null cierra/oculta el dialog. */
  readonly presupuestoId = input<number | null>(null);
  /** Emite cuando se creó el pedido OK y se marcó el presupuesto como
   *  convertido. El payload trae ambos ids para que el padre pueda
   *  actualizar su listado o navegar. */
  readonly pedidoCreado = output<{ presupuestoId: number; pedidoLocalId: number }>();

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
    precioConIva: number;
    porcIva: number | null;
    descuentoPorcentaje: number | null;
    /** Rubro del ítem — define el perfil (menaje/maquinaria) con que se calcula
     *  el precio por forma de pago, igual que en scan/visor/presupuestador. */
    rubro: string | null;
    comentarios: string | null;
  }[]>([]);

  // Datos del cliente — pre-llenados desde el presupuesto, editables.
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

  readonly opcionesRubroPedido: { label: string; value: string }[] = [
    { label: 'Bar', value: 'bar' },
    { label: 'Restaurant', value: 'restaurant' },
    { label: 'Catering', value: 'catering' },
    { label: 'Cafetería', value: 'cafeteria' },
    { label: 'Panadería', value: 'panaderia' },
    { label: 'Pastelería', value: 'pasteleria' },
    { label: 'Otros…', value: 'otros' },
  ];

  // Fijos que DUX espera y NO son editables.
  readonly apellidoRazonSocialFijo = APELLIDO_RAZON_SOCIAL;
  readonly categoriaFiscalFija = 'CONSUMIDOR_FINAL';

  // ----------- Totales por forma de pago -----------
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
      const precioU = precioPorForma(it.precioConIva, it.porcIva, perfilForma(forma, esMaq));
      const factorDesc = 1 - (it.descuentoPorcentaje ?? 0) / 100;
      return acc + precioU * it.cantidad * factorDesc;
    }, 0);
  }

  // ----------- Validación -----------
  readonly puedeCrearPedido = computed(() => {
    const cuit = this.pedidoCuit();
    const cuitOk = cuit != null && String(cuit).length === 11;
    const emailOk = /^[^@\s,]+@[^@\s,]+\.[^@\s,]+$/.test(this.pedidoEmail().trim());
    const nombreOk = this.pedidoNombre().trim().length > 0;
    const telOk = this.pedidoTelefono().trim().length > 0;
    const rubro = this.pedidoRubro();
    const rubroOk = !!rubro && (rubro !== 'otros' || this.pedidoRubroOtros().trim().length > 0);
    return cuitOk && emailOk && nombreOk && telOk && rubroOk
      && this.itemsDelPresupuesto().length > 0;
  });

  // ----------- Lifecycle: cargar detalle al abrir -----------
  constructor() {
    // Formas de pago activas — fuente compartida. Se cargan una vez; el default
    // (primera forma) se setea cuando llegan, respetando la guarda de "solo si
    // no hay una elegida todavía".
    this.precioPerfil.cargar();
    effect(() => {
      const lista = this.precioPerfil.formasPago();
      if (lista.length > 0 && untracked(() => this.pedidoFormaPagoId()) == null) {
        this.pedidoFormaPagoId.set(lista[0].id);
      }
    });

    // Cuando `visible` pasa a true con un `presupuestoId` válido, carga el
    // detalle del presupuesto y pre-llena el form. Effect garantiza que se
    // re-ejecute si el id cambia (caso teórico: el padre quiere reusar el
    // dialog para otro presupuesto sin desmontarlo).
    effect(() => {
      const v = this.visible();
      const id = this.presupuestoId();
      if (!v || id == null) return;
      this.cargarDetalle(id);
    });
  }

  private cargarDetalle(id: number): void {
    this.cargandoDetallePresupuesto.set(true);
    this.cambiosPrecio.set([]);
    this.api.obtenerDetallePresupuestoComercial(id).subscribe({
      next: (det) => {
        this.cargandoDetallePresupuesto.set(false);
        this.pedidoNombre.set(det.clienteNombre ?? '');
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
        // Defaults no derivados del presupuesto
        this.pedidoDomicilio.set('');
        this.pedidoCodigoProvincia.set(null);
        this.pedidoIdLocalidad.set(null);
        this.localidadesPedido.set([]);
        this.pedidoFormaPagoId.set(null);

        this.itemsDelPresupuesto.set(det.items.map((it) => ({
          sku: it.sku,
          cantidad: it.cantidad,
          precioConIva: it.precioConIva,
          porcIva: it.porcIva,
          descuentoPorcentaje: it.descuentoPorcentaje,
          rubro: it.rubro ?? null,
          comentarios: it.comentarios ?? null,
        })));

        this.cargarProvinciasSiHaceFalta();
        this.cargarFormasPagoSiHaceFalta();
        this.verificarCambiosPrecio();
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

  /** Compara el precio snapshot de cada ítem contra el precio de lista ACTUAL
   *  del cache (lookup bulk, sin DUX → instantáneo) y publica las diferencias en
   *  {@link cambiosPrecio}. Excluye genéricos (tienen {@code comentarios} y un
   *  SKU comodín cuyo precio no representa al producto). Best-effort: si el
   *  lookup falla, no muestra nada (no bloquea la creación del pedido). */
  private verificarCambiosPrecio(): void {
    const items = this.itemsDelPresupuesto();
    const skus = items.filter((it) => !it.comentarios).map((it) => it.sku);
    if (skus.length === 0) return;
    this.api.lookupBulk(skus).subscribe({
      next: (catalogo) => {
        const porSku = new Map(catalogo.map((c) => [c.sku, c]));
        const cambios = items.flatMap((it) => {
          if (it.comentarios) return [];
          const actual = porSku.get(it.sku);
          const nuevo = actual?.pvpKtGastroConIva;
          if (nuevo == null || it.precioConIva == null || nuevo === it.precioConIva) {
            return [];
          }
          return [{
            sku: it.sku,
            descripcion: actual?.descripcion ?? it.sku,
            precioViejo: it.precioConIva,
            precioNuevo: nuevo,
            deltaPct: it.precioConIva > 0
              ? ((nuevo - it.precioConIva) / it.precioConIva) * 100
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
    this.api.obtenerProvincias().subscribe({
      next: (lista) => this.provinciasPedido.set(lista),
      error: (err) =>
        toastError(this.toast, 'Provincias', err, 'No se pudieron cargar las provincias'),
    });
  }

  /** Setea la forma de pago por defecto (primera de las activas) si todavía no
   *  hay ninguna elegida. Las formas las provee el servicio compartido (ya
   *  cargadas en el constructor); este método cubre el caso de re-apertura del
   *  dialog tras un reset de {@code pedidoFormaPagoId}. */
  private cargarFormasPagoSiHaceFalta(): void {
    const lista = this.formasPagoActivas();
    if (lista.length > 0 && this.pedidoFormaPagoId() == null) {
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
    this.localidadesSub = this.api.obtenerLocalidades(codigo).subscribe({
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
    this.pedidoCuit.set(digits ? Number(digits) : null);
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
        detail: 'CUIT 11 dígitos, nombre, teléfono, email y rubro son obligatorios.',
        life: 4000,
      });
      return;
    }
    const presupuestoId = this.presupuestoId();
    if (presupuestoId == null) return;

    const cuit = this.pedidoCuit()!;
    const req: CrearPedidoRequest = {
      apellidoRazonSocial: APELLIDO_RAZON_SOCIAL,
      nombre: this.pedidoNombre().trim(),
      categoriaFiscal: 'CONSUMIDOR_FINAL',
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
      // Este dialog SIEMPRE transforma un presupuesto → marcamos el origen para
      // que el backend no consuma la sesión de atención activa del operador.
      origenPresupuesto: true,
      items: this.itemsDelPresupuesto().map((it) => ({
        sku: it.sku,
        cantidad: it.cantidad,
        precioUnitario: it.precioConIva,
        descuentoPorcentaje: it.descuentoPorcentaje ?? undefined,
        // porcIva: relevante solo para items genéricos (el backend usa el
        // del cache para items normales). Lo forwardeamos siempre cuando
        // está presente — no estorba para items normales.
        porcIva: it.porcIva ?? undefined,
        // Comentarios: viaja al campo `comentarios` de la línea en el
        // payload DUX. Para items normales es null; para genéricos es la
        // descripción tipeada por el operador en el presupuesto.
        comentarios: it.comentarios ?? undefined,
      })),
    };

    this.enviandoPedido.set(true);
    this.api.crearPedido(req).subscribe({
      next: (res) => {
        this.enviandoPedido.set(false);
        if (res.estado === 'ENVIADO') {
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
        toastError(this.toast, 'Crear pedido', err, 'Error al enviar el pedido a DUX.');
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
