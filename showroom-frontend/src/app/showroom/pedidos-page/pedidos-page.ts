import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subject, debounceTime } from 'rxjs';
import { MessageService } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { DatePickerModule } from 'primeng/datepicker';
import { DialogModule } from 'primeng/dialog';
import { IconFieldModule } from 'primeng/iconfield';
import { ImageModule } from 'primeng/image';
import { InputIconModule } from 'primeng/inputicon';
import { InputTextModule } from 'primeng/inputtext';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { SelectModule } from 'primeng/select';
import { SkeletonModule } from 'primeng/skeleton';
import { TableLazyLoadEvent, TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { TextareaModule } from 'primeng/textarea';
import { TooltipModule } from 'primeng/tooltip';
import {
  EstadoPedido,
  PedidoDetalle,
  PedidoListItem,
} from '../models';
import { BackendStatusService } from '../backend-status.service';
import { PrecioPerfilService } from '../precio-perfil.service';
import { precioSinIva as quitarIva } from '../precio-referencia.util';
import { ShowroomService } from '../showroom.service';
import { finDelDia, marcarEnSet, sortDesdeLazyLoad } from '../tabla.utils';
import { toastError } from '../toast.utils';
import { PageHeader } from '../page-header/page-header';

@Component({
  selector: 'app-pedidos-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    FormsModule,
    ButtonModule,
    CardModule,
    DatePickerModule,
    DialogModule,
    IconFieldModule,
    ImageModule,
    InputIconModule,
    InputTextModule,
    ProgressSpinnerModule,
    SelectModule,
    SkeletonModule,
    TableModule,
    TagModule,
    TextareaModule,
    TooltipModule,
    RouterLink,
    PageHeader,  ],
  templateUrl: './pedidos-page.html',
  styleUrl: './pedidos-page.scss',
})
export class PedidosPage {
  private readonly api = inject(ShowroomService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly backendStatus = inject(BackendStatusService);
  private readonly precioPerfil = inject(PrecioPerfilService);

  readonly busqueda = signal('');
  readonly estado = signal<EstadoPedido | null>(null);
  readonly desde = signal<Date | null>(null);
  readonly hasta = signal<Date | null>(null);
  /** Cuando la ruta trae {@code ?id=X} (deep-link desde /historial), filtramos
   *  la lista a ese pedido y la auto-expandimos. Null = listado normal. */
  readonly pedidoIdFiltro = signal<number | null>(null);

  readonly cargando = signal(false);
  readonly pedidos = signal<PedidoListItem[]>([]);
  readonly total = signal(0);
  readonly pageSize = signal(50);
  readonly first = signal(0);
  /** Campo de orden actual — coincide con los keys de `SORT_PEDIDOS` del backend. */
  readonly sortField = signal<string>('creadoAt');
  readonly sortOrder = signal<'asc' | 'desc'>('desc');

  /** Cache de detalles ya obtenidos: id → PedidoDetalle. Se carga al expandir. */
  readonly detalles = signal<Record<number, PedidoDetalle>>({});
  readonly cargandoDetalle = signal<Set<number>>(new Set());

  readonly enviandoEmail = signal<Set<number>>(new Set());
  readonly enviandoWhatsapp = signal<Set<number>>(new Set());
  readonly generandoPickit = signal<Set<number>>(new Set());
  readonly anulandoPedido = signal<Set<number>>(new Set());
  readonly reactivandoPedido = signal<Set<number>>(new Set());

  /** Pedido que el operador eligió anular — null cuando el dialog está cerrado.
   *  Guardamos la fila completa (no solo el id) para mostrar contexto en el
   *  dialog (cliente, total, si está cargado en DUX, etc.). */
  readonly pedidoAAnular = signal<PedidoListItem | null>(null);
  /** Texto del textarea de motivo dentro del dialog de anulación. */
  readonly motivoAnulacion = signal('');

  /** Pedido que el operador eligió revertir — null cuando el dialog está cerrado. */
  readonly pedidoAReactivar = signal<PedidoListItem | null>(null);

  /** Filas expandidas (row expansion del p-table). */
  readonly expanded = signal<Record<number, boolean>>({});

  readonly opcionesEstado: { label: string; value: EstadoPedido | null }[] = [
    { label: 'Todos', value: null },
    { label: 'CARGADO EN DUX', value: 'ENVIADO' },
    { label: 'PENDIENTE', value: 'PENDIENTE' },
    { label: 'ERROR', value: 'ERROR' },
    { label: 'ANULADO', value: 'ANULADO' },
  ];

  readonly hayFiltros = computed(
    () =>
      this.pedidoIdFiltro() !== null ||
      this.busqueda().trim().length > 0 ||
      this.estado() !== null ||
      this.desde() !== null ||
      this.hasta() !== null,
  );

  private readonly filtroTrigger$ = new Subject<void>();

  constructor() {
    // Carga la lista de rubros sin IVA (perfil maquinaria) para el marcador.
    this.precioPerfil.cargar();

    this.filtroTrigger$
      .pipe(debounceTime(300), takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.first.set(0);
        this.cargar(0, this.pageSize());
      });

    // Cuando otro operador anula/reactiva un pedido, recibimos el evento SSE
    // y recargamos el listado. Es un broadcast global — todos los operadores
    // con la pantalla abierta se sincronizan automáticamente.
    this.backendStatus.pedidoActualizado$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((ev) => {
        // Solo recargamos si el pedido afectado podría estar visible en la
        // página actual — sino el operador está mirando otros datos y un
        // refetch sería ruido.
        if (this.pedidos().some((p) => p.id === ev.pedidoId)) {
          this.cargar(Math.floor(this.first() / this.pageSize()), this.pageSize());
        }
      });

    // Guard contra doble request inicial: el effect corre la primera vez al
    // mount (los signals tienen valor inicial) y `onLazyLoad` del p-table
    // también dispara. Si no skipeamos la primera, se hacen 2 cargas idénticas.
    let filtrosInicializados = false;
    effect(() => {
      this.pedidoIdFiltro();
      this.busqueda();
      this.estado();
      this.desde();
      this.hasta();
      if (!filtrosInicializados) {
        filtrosInicializados = true;
        return;
      }
      this.filtroTrigger$.next();
    });

    // Deep-link desde /clientes: ?q=<frag tel> → pre-llena la búsqueda para
    // listar solo los pedidos de ese cliente. Mismo patrón que el historial de
    // presupuestos. Se evalúa una sola vez al montar.
    const qParam = this.route.snapshot.queryParamMap.get('q');
    if (qParam) {
      this.busqueda.set(qParam);
    }

    // Deep-link desde /historial: ?id=123 → filtrar a ese pedido y auto-expandir.
    // queryParamMap se evalúa una sola vez al montar (suficiente — la pantalla
    // no se re-navega a sí misma con distinto id en el mismo ciclo de vida).
    const idParam = this.route.snapshot.queryParamMap.get('id');
    if (idParam) {
      const n = Number(idParam);
      if (Number.isFinite(n) && n > 0) {
        this.pedidoIdFiltro.set(n);
        this.expanded.set({ [n]: true });
        this.cargarDetalle(n);
      }
    }
  }

  onLazyLoad(event: TableLazyLoadEvent): void {
    const size = event.rows ?? this.pageSize();
    const first = event.first ?? 0;
    this.pageSize.set(size);
    this.first.set(first);
    const { sortField, sortOrder } = sortDesdeLazyLoad(event, this.sortField(), this.sortOrder());
    this.sortField.set(sortField);
    this.sortOrder.set(sortOrder);
    const page = Math.floor(first / size);
    this.cargar(page, size);
  }

  private cargar(page: number, size: number): void {
    this.cargando.set(true);
    const desde = this.desde();
    const hasta = this.hasta();
    this.api
      .listarPedidos({
        id: this.pedidoIdFiltro() ?? undefined,
        q: this.busqueda(),
        estado: this.estado() ?? undefined,
        desde: desde ? desde.toISOString() : undefined,
        hasta: hasta ? finDelDia(hasta).toISOString() : undefined,
        page,
        size,
        sortField: this.sortField(),
        sortOrder: this.sortOrder(),
      })
      .subscribe({
        next: (resp) => {
          this.cargando.set(false);
          this.pedidos.set(resp.items);
          this.total.set(resp.total);
          // Al cambiar la página, colapsar las filas expandidas (los detalles ya
          // cacheados siguen sirviendo si el usuario re-expande). Excepción: si
          // venimos de un deep-link {@code ?id=X}, mantenemos esa fila expandida.
          const filtro = this.pedidoIdFiltro();
          this.expanded.set(filtro != null ? { [filtro]: true } : {});
        },
        error: (err) => {
          this.cargando.set(false);
          toastError(this.toast, 'Pedidos', err, 'No se pudo cargar el listado');
        },
      });
  }

  limpiarFiltros(): void {
    this.pedidoIdFiltro.set(null);
    this.busqueda.set('');
    this.estado.set(null);
    this.desde.set(null);
    this.hasta.set(null);
  }

  toggleRow(p: PedidoListItem): void {
    const exp = { ...this.expanded() };
    if (exp[p.id]) {
      delete exp[p.id];
      this.expanded.set(exp);
      return;
    }
    exp[p.id] = true;
    this.expanded.set(exp);
    if (!this.detalles()[p.id]) {
      this.cargarDetalle(p.id);
    }
  }

  estaExpandido(id: number): boolean {
    return !!this.expanded()[id];
  }

  estaCargandoDetalle(id: number): boolean {
    return this.cargandoDetalle().has(id);
  }

  detalle(id: number): PedidoDetalle | undefined {
    return this.detalles()[id];
  }

  private cargarDetalle(id: number): void {
    const set = new Set(this.cargandoDetalle());
    set.add(id);
    this.cargandoDetalle.set(set);
    this.api.obtenerPedido(id).subscribe({
      next: (det) => {
        this.detalles.set({ ...this.detalles(), [id]: det });
        const s = new Set(this.cargandoDetalle());
        s.delete(id);
        this.cargandoDetalle.set(s);
      },
      error: (err) => {
        const s = new Set(this.cargandoDetalle());
        s.delete(id);
        this.cargandoDetalle.set(s);
        toastError(this.toast, 'Detalle', err, 'No se pudo cargar el detalle');
      },
    });
  }

  /** Texto de la columna Cliente (también en detalle y modal de anulación):
   *  razón social como principal + nombre informal entre paréntesis si difiere.
   *  `apellidoRazonSocial` es la razón social real editable (obligatoria en
   *  pedidos nuevos, va a DUX); `nombre` es el contacto opcional. Se ignoran los
   *  placeholders legacy ("PEDIDO SHOWROOM"/"PRESUPUESTO") que algunos pedidos
   *  viejos guardaban en la razón social. Si falta uno, muestra el otro; si
   *  faltan ambos, null para que el template muestre "—". */
  nombreCliente(p: { nombre: string | null; apellidoRazonSocial: string | null }): string | null {
    const razon = this.sinPlaceholderLegacy(p.apellidoRazonSocial);
    const nombre = p.nombre?.trim() || null;
    if (razon && nombre && razon.toLowerCase() !== nombre.toLowerCase()) {
      return `${razon} (${nombre})`;
    }
    return razon ?? nombre;
  }

  /** Razón social trimmeada, descartando los placeholders legacy que los pedidos
   *  viejos del showroom/presupuesto guardaban en `apellidoRazonSocial` (el código
   *  actual ya guarda la razón social real). Null si queda vacía. */
  private sinPlaceholderLegacy(razon: string | null): string | null {
    const v = razon?.trim();
    if (!v) return null;
    const up = v.toUpperCase();
    return up === 'PEDIDO SHOWROOM' || up === 'PRESUPUESTO' ? null : v;
  }

  /** Filtro para abrir la ficha del cliente desde la lista: teléfono (últimos 8
   *  dígitos, igual que el camino inverso en la página de clientes), porque el
   *  maestro está indexado por teléfono. Sin teléfono cae a CUIT y, en última
   *  instancia, a la razón social o el nombre crudos (no al texto compuesto con
   *  paréntesis, que no serviría como término de búsqueda). Null si no hay nada
   *  con qué identificar al cliente. */
  private filtroCliente(p: PedidoListItem): string | null {
    const tel = (p.telefono ?? '').replace(/\D+/g, '');
    if (tel) return tel.slice(-8);
    if (p.nroDoc != null) return String(p.nroDoc);
    return this.sinPlaceholderLegacy(p.apellidoRazonSocial) ?? p.nombre?.trim() ?? null;
  }

  /** True si la fila tiene con qué filtrar la ficha del cliente. */
  tieneFichaCliente(p: PedidoListItem): boolean {
    return this.filtroCliente(p) != null;
  }

  /** Navega a la tabla de Clientes filtrada por este cliente. */
  verCliente(p: PedidoListItem): void {
    const q = this.filtroCliente(p);
    if (!q) return;
    this.router.navigate(['/clientes'], { queryParams: { q } });
  }

  estadoSeverity(e: EstadoPedido): 'success' | 'warn' | 'danger' | 'secondary' {
    if (e === 'ENVIADO') return 'success';
    if (e === 'PENDIENTE') return 'warn';
    if (e === 'ANULADO') return 'secondary';
    return 'danger';
  }

  /** Etiqueta amigable para el estado del pedido. "ENVIADO" se muestra como
   *  "CARGADO EN DUX" para evitar confundirlo con "despachado al cliente"
   *  (físicamente). El enum del backend se mantiene como ENVIADO para no
   *  romper compatibilidad con datos viejos. */
  estadoLabel(e: EstadoPedido): string {
    if (e === 'ENVIADO') return 'CARGADO EN DUX';
    return e;
  }

  /** Precio sin IVA por unidad. Considera si la forma de pago aplica IVA al
   *  precio guardado: por default (aplicaIva true o null) el {@code precioUnitario}
   *  ya tiene IVA y se divide; si {@code aplicaIva===false} el precio guardado
   *  ya es sin IVA (el cliente paga sin IVA y DUX absorbe). */
  private precioSinIva(precioGuardado: number | null, porcIva: number | null, aplicaIva: boolean | null): number | null {
    if (aplicaIva === false) return precioGuardado;
    return quitarIva(precioGuardado, porcIva);
  }

  /** Precio con IVA por unidad. Default: el {@code precioUnitario} ya tiene IVA.
   *  Si {@code aplicaIva===false}, hay que sumarle IVA porque está sin (DUX recibe con). */
  private precioConIva(precioGuardado: number | null, porcIva: number | null, aplicaIva: boolean | null): number | null {
    if (precioGuardado == null) return null;
    if (aplicaIva !== false) return precioGuardado;
    if (porcIva == null || porcIva === 0) return precioGuardado;
    return precioGuardado * (1 + porcIva / 100);
  }

  /** Precio unitario que CORRESPONDE a la forma de pago, por ítem según su
   *  perfil (menaje/maquinaria): c/IVA si el perfil aplica IVA, s/IVA si no.
   *  La tabla del pedido muestra solo este precio (no ambos) para no confundir.
   *  El {@code aplicaIva} por ítem cae al flag global del pedido en pedidos
   *  anteriores a esa columna. */
  precioForma(
    it: { precioUnitario: number | null; porcIva: number | null; aplicaIva: boolean | null },
    det: PedidoDetalle,
  ): number | null {
    const ai = it.aplicaIva ?? det.formaPagoAplicaIva;
    return ai === false
      ? this.precioSinIva(it.precioUnitario, it.porcIva, ai)
      : this.precioConIva(it.precioUnitario, it.porcIva, ai);
  }

  /** True si el ítem se cotiza con IVA bajo la forma — define el sufijo
   *  "c/IVA" vs "s/IVA" del precio en la tabla. */
  ivaForma(it: { aplicaIva: boolean | null }, det: PedidoDetalle): boolean {
    return (it.aplicaIva ?? det.formaPagoAplicaIva) !== false;
  }

  /** Subtotal NETO de la línea que PAGA el cliente = precio unitario BRUTO (c/IVA
   *  si la forma aplica IVA, s/IVA si no) × cantidad × (1 − descuento/100). La
   *  suma de estos subtotales da "Cliente paga" ({@code det.total}). El precio
   *  unitario que se muestra (c/IVA o s/IVA según el perfil del ítem) lo
   *  resuelve {@link precioForma}. */
  subtotalCliente(
    it: { precioUnitario: number | null; cantidad: number | null; descuentoPorcentaje?: number | null },
  ): number | null {
    if (it.precioUnitario == null || it.cantidad == null) return null;
    const factor = 1 - (it.descuentoPorcentaje ?? 0) / 100;
    return it.precioUnitario * it.cantidad * factor;
  }

  /** Total c/IVA que DUX facturó = suma por ítem del precio con IVA, con el
   *  descuento de la línea aplicado (DUX lo recibe como porc_desc). Para ítems
   *  que el cliente pagó sin IVA, DUX igual facturó con IVA (el operador absorbe
   *  la diferencia). Usa el {@code aplicaIva} por ítem — un pedido mixto tiene
   *  ítems con IVA (menaje) y sin IVA (maquinaria); cae al flag global del
   *  pedido en pedidos anteriores a esa columna. El {@code precioUnitario} es
   *  BRUTO, así que hay que descontar acá igual que en {@link subtotalCliente}. */
  totalDux(det: PedidoDetalle): number | null {
    if (det.total == null) return null;
    if (!det.items?.length) return det.total;
    let suma = 0;
    for (const it of det.items) {
      const ai = it.aplicaIva ?? det.formaPagoAplicaIva;
      const p = this.precioConIva(it.precioUnitario, it.porcIva, ai);
      if (p == null) return det.total;
      const factor = 1 - (it.descuentoPorcentaje ?? 0) / 100;
      suma += p * (it.cantidad ?? 0) * factor;
    }
    return suma;
  }

  /** IVA que el operador absorbió: lo que DUX facturó de más respecto de lo que
   *  pagó el cliente. ~0 cuando el cliente pagó todo con IVA. */
  ivaAbsorbido(det: PedidoDetalle): number | null {
    const tDux = this.totalDux(det);
    if (tDux == null || det.total == null) return null;
    return tDux - det.total;
  }

  /** True si hubo al menos un ítem que el cliente pagó sin IVA (DUX facturó de
   *  más). Tolerancia de medio peso para no disparar por redondeo. */
  huboAbsorcion(det: PedidoDetalle): boolean {
    const a = this.ivaAbsorbido(det);
    return a != null && a > 0.5;
  }

  /** IVA contenido en lo que pagó el cliente. Sólo tiene sentido cuando NO hubo
   *  absorción (el cliente pagó con IVA). */
  ivaContenido(det: PedidoDetalle): number | null {
    if (det.total == null || det.totalSinIva == null) return null;
    return det.total - det.totalSinIva;
  }

  /** Monto del recargo por financiación = lo que paga el cliente menos el
   *  precio sin financiación (al contado). Null si no hubo recargo. Hace
   *  verificable la diferencia contado↔financiado: el `recargoPorcentaje` es el
   *  parámetro de la fórmula (descuento por contado, base/(1−r)), NO el % real
   *  de aumento — así que mostrar el monto evita la cuenta engañosa de `×(1+r)`. */
  montoRecargo(det: PedidoDetalle): number | null {
    if (det.total == null || det.totalSinRecargo == null) return null;
    const m = det.total - det.totalSinRecargo;
    return m > 0.5 ? m : null;
  }

  /** Texto del tooltip que aclara la convención del recargo: el `%` es el
   *  descuento por pago al contado (fórmula base/(1−r)), no el % literal de
   *  aumento — por eso el monto del recargo es mayor que `base × %`. El divisor
   *  se formatea a 2 decimales para evitar floating-point feo (ej. 0,67). */
  tooltipRecargo(porc: number | null | undefined): string {
    const r = porc ?? 0;
    const divisor = (1 - r / 100).toFixed(2).replace('.', ',');
    return (
      `El ${r}% es el descuento por pago al contado: el precio financiado se calcula ` +
      `como base ÷ ${divisor}. Por eso el monto del recargo no es el ${r}% de la base, sino algo mayor.`
    );
  }

  /** True si el nombre de la forma de pago ya menciona la cantidad de cuotas
   *  (ej. "6 Cuotas"), para no repetir "· N cuotas" al lado. Busca el número
   *  como token aislado (delimitado por no-dígitos) para no matchear, p. ej.,
   *  el "6" embebido en "16". */
  nombreIncluyeCuotas(
    nombre: string | null | undefined,
    cuotas: number | null | undefined,
  ): boolean {
    if (!nombre || cuotas == null) return false;
    return new RegExp(`(^|\\D)${cuotas}(\\D|$)`).test(nombre);
  }

  trackById = (_: number, it: PedidoListItem) => it.id;

  /** Marca de maquinaria (rubro de la lista configurable que cotiza sin IVA) —
   *  mismo criterio que productos. */
  esRubroMaquinaria(rubro: string | null | undefined): boolean {
    return this.precioPerfil.rubroCotizaSinIva(rubro);
  }

  estaEnviandoEmail(id: number): boolean {
    return this.enviandoEmail().has(id);
  }

  estaAnulando(id: number): boolean {
    return this.anulandoPedido().has(id);
  }

  /** Un pedido se puede anular salvo que ya esté en estado ANULADO. */
  puedeAnular(p: PedidoListItem): boolean {
    return p.estado !== 'ANULADO';
  }

  /** Abre el diálogo de confirmación de anulación. El operador puede tipear
   *  un motivo opcional. Si el pedido ya estaba CARGADO EN DUX, el dialog
   *  se encarga de mostrar el aviso de cancelación manual. */
  pedirAnular(p: PedidoListItem): void {
    if (!this.puedeAnular(p)) return;
    this.motivoAnulacion.set('');
    this.pedidoAAnular.set(p);
  }

  cancelarAnulacion(): void {
    this.pedidoAAnular.set(null);
    this.motivoAnulacion.set('');
  }

  confirmarAnulacion(): void {
    const p = this.pedidoAAnular();
    if (!p) return;
    if (this.estaAnulando(p.id)) return;
    marcarEnSet(this.anulandoPedido, p.id, true);
    const motivo = this.motivoAnulacion().trim() || null;
    this.api.anularPedido(p.id, motivo).subscribe({
      next: (det) => {
        marcarEnSet(this.anulandoPedido, p.id, false);
        // Reflejar el nuevo estado en la lista sin recargar todo el listado.
        this.pedidos.set(
          this.pedidos().map((x) =>
            x.id === p.id
              ? { ...x, estado: det.estado, anuladoAt: det.anuladoAt }
              : x,
          ),
        );
        // Refrescar el cache de detalle así si la fila estaba expandida muestra
        // el motivo y el timestamp de anulación.
        this.detalles.set({ ...this.detalles(), [p.id]: det });
        this.pedidoAAnular.set(null);
        this.motivoAnulacion.set('');
        this.toast.add({
          severity: 'success',
          summary: 'Pedido anulado',
          detail: `Pedido #${p.id} marcado como ANULADO.`,
          life: 3500,
        });
      },
      error: (err) => {
        marcarEnSet(this.anulandoPedido, p.id, false);
        toastError(this.toast, 'Anular', err, 'No se pudo anular el pedido');
      },
    });
  }

  estaReactivando(id: number): boolean {
    return this.reactivandoPedido().has(id);
  }

  /** Un pedido se puede revertir solo si está en estado ANULADO. */
  puedeReactivar(p: PedidoListItem): boolean {
    return p.estado === 'ANULADO';
  }

  /** Abre el diálogo de confirmación para revertir la anulación. */
  pedirReactivar(p: PedidoListItem): void {
    if (!this.puedeReactivar(p)) return;
    this.pedidoAReactivar.set(p);
  }

  cancelarReactivacion(): void {
    this.pedidoAReactivar.set(null);
  }

  confirmarReactivacion(): void {
    const p = this.pedidoAReactivar();
    if (!p) return;
    if (this.estaReactivando(p.id)) return;
    marcarEnSet(this.reactivandoPedido, p.id, true);
    this.api.reactivarPedido(p.id).subscribe({
      next: (det) => {
        marcarEnSet(this.reactivandoPedido, p.id, false);
        this.pedidos.set(
          this.pedidos().map((x) =>
            x.id === p.id
              ? { ...x, estado: det.estado, anuladoAt: det.anuladoAt }
              : x,
          ),
        );
        this.detalles.set({ ...this.detalles(), [p.id]: det });
        this.pedidoAReactivar.set(null);
        this.toast.add({
          severity: 'success',
          summary: 'Pedido reactivado',
          detail: `Pedido #${p.id} restaurado a estado ${this.estadoLabel(det.estado)}.`,
          life: 3500,
        });
      },
      error: (err) => {
        marcarEnSet(this.reactivandoPedido, p.id, false);
        toastError(this.toast, 'Reactivar', err, 'No se pudo reactivar el pedido');
      },
    });
  }

  reenviarEmail(p: PedidoListItem): void {
    if (this.estaEnviandoEmail(p.id)) return;
    marcarEnSet(this.enviandoEmail, p.id, true);
    this.api.reenviarEmailPedido(p.id).subscribe({
      next: () => {
        marcarEnSet(this.enviandoEmail, p.id, false);
        // El toast de éxito real lo dispara el SSE picking-email cuando el async
        // completa (en app.ts). Mostramos solo un info inmediato para confirmar
        // que la acción se aceptó.
        this.toast.add({
          severity: 'info',
          summary: 'Email encolado',
          detail: 'Generando adjuntos y enviando…',
          life: 3000,
        });
      },
      error: (err) => {
        marcarEnSet(this.enviandoEmail, p.id, false);
        toastError(this.toast, 'Email', err, 'No se pudo encolar el envío');
      },
    });
  }

  estaEnviandoWhatsapp(id: number): boolean {
    return this.enviandoWhatsapp().has(id);
  }

  reenviarWhatsapp(p: PedidoListItem): void {
    if (this.estaEnviandoWhatsapp(p.id)) return;
    marcarEnSet(this.enviandoWhatsapp, p.id, true);
    this.api.reenviarWhatsappPedido(p.id).subscribe({
      next: () => {
        marcarEnSet(this.enviandoWhatsapp, p.id, false);
        // El resultado real (SENT / WINDOW_CLOSED / FAILED) llega vía SSE
        // whatsapp-business y se muestra como toast desde app.ts.
        this.toast.add({
          severity: 'info',
          summary: 'WhatsApp encolado',
          detail: 'Subiendo PDF a Meta y mandando…',
          life: 3000,
        });
      },
      error: (err) => {
        marcarEnSet(this.enviandoWhatsapp, p.id, false);
        toastError(this.toast, 'WhatsApp', err, 'No se pudo encolar el envío');
      },
    });
  }

  estaGenerandoPickit(id: number): boolean {
    return this.generandoPickit().has(id);
  }

  regenerarPickitExterno(p: PedidoListItem): void {
    if (this.estaGenerandoPickit(p.id)) return;
    marcarEnSet(this.generandoPickit, p.id, true);
    this.api.regenerarPickitExterno(p.id).subscribe({
      next: () => {
        marcarEnSet(this.generandoPickit, p.id, false);
        // El SSE pickit-externo (toast en app.ts) confirma el path generado.
        this.toast.add({
          severity: 'info',
          summary: 'Pickit externo encolado',
          detail: 'Generando archivo…',
          life: 3000,
        });
      },
      error: (err) => {
        marcarEnSet(this.generandoPickit, p.id, false);
        toastError(this.toast, 'Pickit externo', err, 'No se pudo generar el pickit');
      },
    });
  }

}
