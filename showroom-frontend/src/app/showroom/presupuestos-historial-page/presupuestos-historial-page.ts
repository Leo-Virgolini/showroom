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
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Subject, debounceTime } from 'rxjs';
import { ConfirmationService, MenuItem, MessageService } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { DatePickerModule } from 'primeng/datepicker';
import { IconFieldModule } from 'primeng/iconfield';
import { ImageModule } from 'primeng/image';
import { InputIconModule } from 'primeng/inputicon';
import { InputTextModule } from 'primeng/inputtext';
import { SkeletonModule } from 'primeng/skeleton';
import { SplitButtonModule } from 'primeng/splitbutton';
import { TableLazyLoadEvent, TableModule } from 'primeng/table';
import { TooltipModule } from 'primeng/tooltip';
import { PresupuestoDetalle, PresupuestoFormaPagoSnapshot, PresupuestoListItem } from '../models';
import { CrearPedidoDialog } from '../crear-pedido-dialog/crear-pedido-dialog';
import { abrirPdfEnPreview } from '../download.utils';
import { ShowroomService } from '../showroom.service';
import { finDelDia, marcarEnSet, sortDesdeLazyLoad } from '../tabla.utils';
import { toastError } from '../toast.utils';
import { PageHeader } from '../page-header/page-header';
import { perfilForma, precioPorForma } from '../precio-referencia.util';
import { PrecioPerfilService } from '../precio-perfil.service';

/**
 * Listado histórico de presupuestos comerciales guardados.
 *
 * <p>Cada presupuesto persistido en BD (al descargar el PDF o al enviar
 * por email) aparece acá. El operador puede buscar por nombre/email/
 * teléfono o filtrar por fecha, y descargar el PDF para reenviarlo.
 *
 * <p>El estado se mantiene en signals locales — no usa el carrito ni la
 * sesión del backend. La tabla es lazy-load con paginación server-side.
 */
@Component({
  selector: 'app-presupuestos-historial-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    FormsModule,
    ButtonModule,
    CardModule,
    DatePickerModule,
    IconFieldModule,
    ImageModule,
    InputIconModule,
    InputTextModule,
    SkeletonModule,
    SplitButtonModule,
    TableModule,
    TooltipModule,
    CrearPedidoDialog,
    RouterLink,
    PageHeader,  ],
  templateUrl: './presupuestos-historial-page.html',
  styleUrl: './presupuestos-historial-page.scss',
})
export class PresupuestosHistorialPage {
  private readonly api = inject(ShowroomService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly confirmationService = inject(ConfirmationService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly precioPerfil = inject(PrecioPerfilService);

  /** Marca de maquinaria (rubro de la lista configurable que cotiza sin IVA) —
   *  mismo criterio que productos. */
  esRubroMaquinaria(rubro: string | null | undefined): boolean {
    return this.precioPerfil.rubroCotizaSinIva(rubro);
  }

  readonly busqueda = signal('');
  readonly desde = signal<Date | null>(null);
  readonly hasta = signal<Date | null>(null);
  /** Cuando la ruta trae {@code ?id=X} (deep-link desde /pedidos → columna
   *  "Origen"), filtramos la lista a ese presupuesto. Null = listado normal. */
  readonly idFiltro = signal<number | null>(null);

  readonly cargando = signal(false);
  readonly presupuestos = signal<PresupuestoListItem[]>([]);
  readonly total = signal(0);
  readonly pageSize = signal(50);
  readonly first = signal(0);
  /** Campo de orden actual — coincide con los keys de `SORT_PRESUPUESTOS` del backend. */
  readonly sortField = signal<string>('creadoAt');
  readonly sortOrder = signal<'asc' | 'desc'>('desc');

  /** IDs de presupuestos cuyo PDF se está descargando — para deshabilitar
   *  el botón mientras espera el response del backend. */
  readonly descargandoPdf = signal<Set<number>>(new Set());

  /** IDs de presupuestos que se están eliminando — para deshabilitar el
   *  botón mientras espera el response del backend. */
  readonly eliminandoPdf = signal<Set<number>>(new Set());

  /** Filas expandidas con el detalle inline (mismo patrón que el historial de
   *  pedidos): id → true. */
  readonly expanded = signal<Record<number, boolean>>({});
  /** Cache de detalles ya obtenidos: id → PresupuestoDetalle. Se carga al
   *  expandir la fila por primera vez y se reusa si se re-expande. */
  readonly detalles = signal<Record<number, PresupuestoDetalle>>({});
  /** IDs cuyo detalle se está pidiendo al backend — muestra el skeleton. */
  readonly cargandoDetalle = signal<Set<number>>(new Set());

  readonly hayFiltros = computed(
    () =>
      this.idFiltro() !== null ||
      this.busqueda().trim().length > 0 ||
      this.desde() !== null ||
      this.hasta() !== null,
  );

  /** Cuando algún filtro cambia, reseteamos al primer page y recargamos.
   *  Debounce para que tipear en el input de búsqueda no dispare un
   *  request por cada letra. */
  private readonly filtroTrigger$ = new Subject<void>();
  /** Skip del primer disparo del effect (los signals tienen valor inicial,
   *  así que el effect corre al mount aunque no haya cambio real). Evita
   *  el doble request inicial junto con {@code onLazyLoad}. */
  private filtrosInicializados = false;

  constructor() {
    // Carga la lista de rubros sin IVA (perfil maquinaria) para el marcador.
    this.precioPerfil.cargar();

    // Pre-llena la búsqueda con el queryParam `q` cuando se navega desde la
    // página de Clientes ("Ver presupuestos de este cliente").
    const qParam = this.route.snapshot.queryParamMap.get('q');
    if (qParam) {
      this.busqueda.set(qParam);
    }

    // Deep-link desde /pedidos (columna "Origen"): ?id=123 → filtrar la lista
    // a ese presupuesto. queryParamMap se evalúa una sola vez al montar.
    const idParam = this.route.snapshot.queryParamMap.get('id');
    if (idParam) {
      const n = Number(idParam);
      if (Number.isFinite(n) && n > 0) {
        this.idFiltro.set(n);
      }
    }

    this.filtroTrigger$
      .pipe(debounceTime(300), takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.first.set(0);
        this.cargar(0, this.pageSize());
      });

    effect(() => {
      this.idFiltro();
      this.busqueda();
      this.desde();
      this.hasta();
      if (!this.filtrosInicializados) {
        this.filtrosInicializados = true;
        return;
      }
      this.filtroTrigger$.next();
    });
  }

  onLazyLoad(event: TableLazyLoadEvent): void {
    const size = event.rows ?? this.pageSize();
    const first = event.first ?? 0;
    this.pageSize.set(size);
    this.first.set(first);
    const { sortField, sortOrder } = sortDesdeLazyLoad(event, this.sortField(), this.sortOrder());
    this.sortField.set(sortField);
    this.sortOrder.set(sortOrder);
    this.cargar(Math.floor(first / size), size);
  }

  private cargar(page: number, size: number): void {
    this.cargando.set(true);
    const desde = this.desde();
    const hasta = this.hasta();
    this.api
      .listarPresupuestosComerciales({
        id: this.idFiltro() ?? undefined,
        q: this.busqueda(),
        desde: desde ? desde.toISOString() : undefined,
        hasta: hasta ? finDelDia(hasta).toISOString() : undefined,
        page,
        size,
        sortField: this.sortField(),
        sortOrder: this.sortOrder(),
      })
      .subscribe({
        next: (res) => {
          this.cargando.set(false);
          // Limpiamos el cache de menús del SplitButton — los presupuestos
          // que ya no están en la página actual no necesitan referencias.
          this.menuCache.clear();
          this.presupuestos.set(res.items);
          this.total.set(res.total);
          // Colapsar las filas expandidas al cambiar de página/filtro — los
          // detalles ya cacheados siguen sirviendo si el operador re-expande.
          this.expanded.set({});
        },
        error: (err) => {
          this.cargando.set(false);
          toastError(this.toast, 'Historial', err,
            'No se pudieron cargar los presupuestos.');
        },
      });
  }

  /** Descarga el PDF de un presupuesto: lo abre en pestaña nueva y lo
   *  guarda a disco con su filename original.
   *
   *  @param modo Si se especifica, fuerza la versión del PDF (agregada o
   *    individual). Si se omite, el backend usa el modo con el que se
   *    generó originalmente. */
  descargar(p: PresupuestoListItem, modo?: 'agregado' | 'individual'): void {
    if (this.descargandoPdf().has(p.id)) return;
    // Truco anti-popup-blocker: abrimos la pestaña en blanco AHORA, sincrónico
    // con el click. Chrome lo trata como user-initiated y no la bloquea.
    // Cuando llega el PDF del backend, se carga el blob en esa pestaña — no
    // auto-descargamos a disco: si el operador quiere bajarlo, lo hace
    // desde el visor del browser.
    const previewTab = window.open('about:blank', '_blank');
    marcarEnSet(this.descargandoPdf, p.id, true);
    this.api.descargarPdfPresupuestoComercial(p.id, modo).subscribe({
      next: (res) => {
        marcarEnSet(this.descargandoPdf, p.id, false);
        const resultado = abrirPdfEnPreview(res, `presupuesto-${p.id}.pdf`, previewTab);
        if (resultado == null) {
          toastError(this.toast, 'Abrir PDF', null, 'El backend no devolvió un PDF.');
          return;
        }
        this.toast.add({
          severity: 'success',
          summary: resultado.previewAbierto ? 'PDF abierto' : 'PDF descargado',
          detail: resultado.previewAbierto
            ? `#${p.id} — se abrió para previsualizar.`
            : `#${p.id} — el browser bloqueó la pestaña preview.`,
          life: 4000,
        });
      },
      error: (err) => {
        if (previewTab) previewTab.close();
        marcarEnSet(this.descargandoPdf, p.id, false);
        toastError(this.toast, 'Abrir PDF', err, 'No se pudo abrir el PDF.');
      },
    });
  }

  /** Cache de menús del SplitButton por id de presupuesto — Angular CD llama
   *  al binding `[model]` en cada render, así que sin cache se crean N×2
   *  objetos MenuItem por cada ciclo. El Map se invalida cuando el listado
   *  se recarga (presupuestos.set(...) crea una identidad nueva). */
  private readonly menuCache = new Map<number, MenuItem[]>();

  /** Items del dropdown del SplitButton de abrir PDF — permite al operador
   *  elegir entre la versión agregada (tabla + total) y la individual
   *  (1 hoja por producto) del mismo presupuesto. El click directo al
   *  botón principal abre la versión con la que se generó originalmente. */
  opcionesDescarga(p: PresupuestoListItem): MenuItem[] {
    const cached = this.menuCache.get(p.id);
    if (cached) return cached;
    const items: MenuItem[] = [
      {
        label: 'Versión agregada',
        icon: 'pi pi-list',
        command: () => this.descargar(p, 'agregado'),
      },
      {
        label: 'Versión individual',
        icon: 'pi pi-clone',
        command: () => this.descargar(p, 'individual'),
      },
    ];
    this.menuCache.set(p.id, items);
    return items;
  }

  /** Confirma con un dialog modal antes de eliminar — el operador puede
   *  borrar por error y el soft-delete es reversible solo desde la DB, así
   *  que es bueno pedir confirmación explícita con el id + nombre del
   *  cliente para que se asegure. */
  confirmarEliminar(p: PresupuestoListItem): void {
    if (this.eliminandoPdf().has(p.id)) return;
    const refCliente = p.clienteNombre ? ` de ${p.clienteNombre}` : '';
    this.confirmationService.confirm({
      header: '¿Eliminar presupuesto?',
      message: `Se va a eliminar el presupuesto #${p.id}${refCliente}. `
        + 'No vas a poder reverlo en el historial. ¿Confirmás?',
      icon: 'pi pi-exclamation-triangle',
      acceptButtonProps: { label: 'Eliminar', severity: 'danger', icon: 'pi pi-trash' },
      rejectButtonProps: { label: 'Cancelar', severity: 'secondary', outlined: true },
      accept: () => this.ejecutarEliminar(p),
    });
  }

  private ejecutarEliminar(p: PresupuestoListItem): void {
    marcarEnSet(this.eliminandoPdf, p.id, true);
    this.api.eliminarPresupuestoComercial(p.id).subscribe({
      next: () => {
        marcarEnSet(this.eliminandoPdf, p.id, false);
        // Update optimista en memoria — sacamos la fila del listado al
        // toque para que la UI reaccione sin esperar el recargado.
        this.presupuestos.set(this.presupuestos().filter((x) => x.id !== p.id));
        this.total.update((t) => Math.max(0, t - 1));
        this.menuCache.delete(p.id);
        this.toast.add({
          severity: 'success',
          summary: 'Presupuesto eliminado',
          detail: `#${p.id} ya no aparece en el historial.`,
          life: 4000,
        });
      },
      error: (err) => {
        marcarEnSet(this.eliminandoPdf, p.id, false);
        toastError(this.toast, 'Eliminar', err, 'No se pudo eliminar el presupuesto.');
      },
    });
  }

  limpiarFiltros(): void {
    this.limpiarIdFiltro();
    this.busqueda.set('');
    this.desde.set(null);
    this.hasta.set(null);
  }

  /** Limpia solo el filtro por id del deep-link (pill "Mostrando presupuesto
   *  #N · Ver todos") y saca el {@code ?id=} de la URL para que un refresh no
   *  vuelva a aplicarlo. La recarga la dispara el effect de filtros. */
  limpiarIdFiltro(): void {
    if (this.idFiltro() === null) return;
    this.idFiltro.set(null);
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { id: null },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  // ============================================================
  // Dialog "Crear pedido en DUX" — la lógica del dialog vive en el
  // componente reusable {@link CrearPedidoDialog}, que se monta en el
  // template. Acá solo mantenemos el estado de visibilidad + el id del
  // presupuesto seleccionado y un handler para actualizar el listado
  // cuando se creó el pedido OK.
  // ============================================================
  readonly mostrarDialogCrearPedido = signal(false);
  /** Id del presupuesto sobre el que se está creando el pedido. Lo
   *  consume {@link CrearPedidoDialog} via @Input para cargar el detalle
   *  internamente y armar el payload. */
  readonly presupuestoIdParaPedido = signal<number | null>(null);
  /** Id del pedido anterior cuando se abre el dialog en modo "regenerar"
   *  (presupuesto ya convertido y editado después). Null = alta normal. */
  readonly pedidoAnteriorParaRegenerar = signal<number | null>(null);

  /** True si el presupuesto se editó DESPUÉS de generar el pedido: tiene pedido,
   *  fecha de conversión y la última modificación es posterior. Solo entonces
   *  ofrecemos "Regenerar pedido". */
  editadoTrasConvertir(p: PresupuestoListItem): boolean {
    return p.convertidoEnPedidoId != null
      && !!p.convertidoAt
      && !!p.modificadoAt
      && new Date(p.modificadoAt).getTime() > new Date(p.convertidoAt).getTime();
  }

  /** Click en "Crear pedido" de una fila — el dialog se encarga de cargar
   *  el detalle y de mostrar su propio spinner mientras lo hace. */
  abrirCrearPedido(p: PresupuestoListItem): void {
    if (p.convertidoEnPedidoId != null) return;
    this.pedidoAnteriorParaRegenerar.set(null);
    this.presupuestoIdParaPedido.set(p.id);
    this.mostrarDialogCrearPedido.set(true);
  }

  /** Click en "Regenerar pedido" — abre el mismo dialog en modo regeneración,
   *  pasando el id del pedido anterior para que el backend lo anule y re-vincule. */
  abrirRegenerarPedido(p: PresupuestoListItem): void {
    if (p.convertidoEnPedidoId == null) return;
    this.pedidoAnteriorParaRegenerar.set(p.convertidoEnPedidoId);
    this.presupuestoIdParaPedido.set(p.id);
    this.mostrarDialogCrearPedido.set(true);
  }

  /** Output del dialog cuando se creó/regeneró el pedido OK. Updateamos el
   *  listado optimistamente: nuevo pedido vinculado + convertidoAt = ahora
   *  (así desaparece el botón "Regenerar" hasta una próxima edición). */
  onPedidoCreado(evt: { presupuestoId: number | null; pedidoLocalId: number }): void {
    const ahora = new Date().toISOString();
    this.presupuestos.set(this.presupuestos().map((x) =>
      x.id === evt.presupuestoId
        ? { ...x, convertidoEnPedidoId: evt.pedidoLocalId, convertidoAt: ahora }
        : x));
    this.pedidoAnteriorParaRegenerar.set(null);
  }

  /** Botón "Ver pedido" — navega a /pedidos con el id como filtro. */
  irAlPedido(pedidoId: number): void {
    this.router.navigate(['/pedidos'], { queryParams: { id: pedidoId } });
  }

  // ============================================================
  // Detalle inline expandible (mismo patrón que el historial de pedidos):
  // chevron por fila que despliega cliente + ítems + formas de pago, cargando
  // el detalle on-demand desde GET /presupuesto-comercial/{id}/detalle.
  // ============================================================

  /** Abre/cierra el detalle de la fila. Carga el detalle del backend la primera
   *  vez (después queda cacheado). */
  toggleRow(p: PresupuestoListItem): void {
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

  detalle(id: number): PresupuestoDetalle | undefined {
    return this.detalles()[id];
  }

  private cargarDetalle(id: number): void {
    marcarEnSet(this.cargandoDetalle, id, true);
    this.api.obtenerDetallePresupuestoComercial(id).subscribe({
      next: (det) => {
        this.detalles.set({ ...this.detalles(), [id]: det });
        marcarEnSet(this.cargandoDetalle, id, false);
      },
      error: (err) => {
        marcarEnSet(this.cargandoDetalle, id, false);
        toastError(this.toast, 'Detalle', err, 'No se pudo cargar el detalle del presupuesto.');
      },
    });
  }

  /** Precio unitario a mostrar para un ítem en el detalle: en la forma elegida
   *  del presupuesto si hay una, o el de referencia (Efectivo) si no. */
  precioItem(
    it: { precioReferencia?: number | null; precioConIva: number; porcIva?: number | null; rubro?: string | null },
    det?: PresupuestoDetalle,
  ): number {
    const elegida = det ? this.formaSeleccionadaDe(det) : null;
    if (elegida) {
      const perfil = this.perfilFormaItem(elegida, it.rubro);
      return precioPorForma(it.precioConIva, it.porcIva ?? null, perfil);
    }
    return it.precioReferencia ?? it.precioConIva;
  }

  /** Perfil (recargo/IVA) de la forma elegida según el rubro del ítem. Fuente
   *  única compartida por {@link precioItem} y {@link ivaItem}, para que el
   *  precio mostrado y el badge c/IVA usen exactamente el mismo perfil. */
  private perfilFormaItem(elegida: PresupuestoFormaPagoSnapshot, rubro: string | null | undefined) {
    return perfilForma(
      {
        recargoPorcentaje: elegida.recargoPorcentaje,
        aplicaIva: elegida.aplicaIva,
        recargoPorcentajeMaquinaria: elegida.recargoPorcentajeMaquinaria ?? null,
        aplicaIvaMaquinaria: elegida.aplicaIvaMaquinaria ?? null,
      },
      this.precioPerfil.rubroCotizaSinIva(rubro),
    );
  }

  /** True si el precio mostrado del ítem es CON IVA. Con una forma elegida usa
   *  el {@code aplicaIva} del perfil de ESA forma según el rubro (puede diferir
   *  del de referencia, p. ej. una transferencia s/IVA); sin forma, el del
   *  precio de referencia (Efectivo). Viejos sin {@code precioReferencia} → c/IVA. */
  ivaItem(
    it: { precioReferencia?: number | null; precioReferenciaConIva?: boolean; rubro?: string | null },
    det?: PresupuestoDetalle,
  ): boolean {
    const elegida = det ? this.formaSeleccionadaDe(det) : null;
    if (elegida) return this.perfilFormaItem(elegida, it.rubro).aplicaIva ?? true;
    if (it.precioReferencia == null) return true;
    return it.precioReferenciaConIva !== false;
  }

  /** Subtotal de la línea = precio (en la forma elegida o Efectivo) × cantidad ×
   *  (1 − desc/100). */
  subtotalItem(
    it: {
      precioReferencia?: number | null;
      precioConIva: number;
      porcIva?: number | null;
      rubro?: string | null;
      cantidad: number;
      descuentoPorcentaje: number | null;
    },
    det?: PresupuestoDetalle,
  ): number {
    return this.precioItem(it, det) * it.cantidad * (1 - (it.descuentoPorcentaje ?? 0) / 100);
  }

  /** Total del presupuesto: si hay forma elegida, su `precioFinal` (snapshot ya
   *  calculado); si no, la suma de los subtotales de referencia (Efectivo). */
  totalPresupuesto(det: PresupuestoDetalle): number {
    const elegida = this.formaSeleccionadaDe(det);
    if (elegida) return elegida.precioFinal ?? 0;
    return det.items.reduce((s, it) => s + this.subtotalItem(it), 0);
  }

  /** Formas de pago "globales" del presupuesto (modo agregado: itemSku null).
   *  En cotización individual las formas se guardan POR ítem (cada una con su
   *  itemSku), así que listarlas planas repetiría los mismos nombres N×M veces;
   *  por eso el panel filtra a las globales y, si no hay (presupuesto
   *  individual), muestra un aviso en lugar de las tarjetas. */
  formasGlobales(det: PresupuestoDetalle): PresupuestoFormaPagoSnapshot[] {
    return (det.formasPago ?? []).filter((f) => f.itemSku == null);
  }

  /** La forma de pago elegida del presupuesto (null = "Todas"), buscada entre
   *  las formas globales por el id persistido. */
  formaSeleccionadaDe(det: PresupuestoDetalle): PresupuestoFormaPagoSnapshot | null {
    const id = det.formaPagoSeleccionadaId;
    if (id == null) return null;
    return this.formasGlobales(det).find((f) => f.id === id) ?? null;
  }

  /** Formas a mostrar en el panel: si hay una elegida, solo esa; si no, todas
   *  las globales (comportamiento histórico). */
  formasAMostrar(det: PresupuestoDetalle): PresupuestoFormaPagoSnapshot[] {
    const elegida = this.formaSeleccionadaDe(det);
    return elegida ? [elegida] : this.formasGlobales(det);
  }

  /** Etiqueta para la 2da línea del header "Precio" del detalle, que aclara a
   *  qué corresponde el precio por ítem: el nombre de la forma elegida si hay
   *  una, o "Referencia" (Efectivo) cuando se muestran todas. En cotización
   *  individual el precio varía por ítem y ninguna forma única lo representa,
   *  así que no se rotula (null). */
  formaHeaderItem(det: PresupuestoDetalle): string | null {
    if (det.cotizacionIndividual) return null;
    const elegida = this.formaSeleccionadaDe(det);
    return elegida ? elegida.nombre : 'Referencia';
  }

  /** True si el nombre de la forma de pago ya menciona la cantidad de cuotas
   *  (ej. "6 Cuotas") — evita repetir "· N cuotas" al lado. Mismo criterio que
   *  el historial de pedidos. */
  nombreIncluyeCuotas(
    nombre: string | null | undefined,
    cuotas: number | null | undefined,
  ): boolean {
    if (!nombre || cuotas == null) return false;
    return new RegExp(`(^|\\D)${cuotas}(\\D|$)`).test(nombre);
  }

  /** Filtro para abrir la ficha del cliente: teléfono (últimos 8 dígitos, igual
   *  que el camino inverso en la página de clientes), porque el maestro está
   *  indexado por teléfono. Sin teléfono cae al nombre. Null si no hay nada. */
  private filtroCliente(p: PresupuestoListItem): string | null {
    const tel = (p.clienteTelefono ?? '').replace(/\D+/g, '');
    if (tel) return tel.slice(-8) || tel;
    return p.clienteNombre?.trim() || null;
  }

  /** True si la fila tiene con qué filtrar la ficha del cliente. */
  tieneFichaCliente(p: PresupuestoListItem): boolean {
    return this.filtroCliente(p) != null;
  }

  /** Navega a la tabla de Clientes filtrada por este cliente. */
  verCliente(p: PresupuestoListItem): void {
    const q = this.filtroCliente(p);
    if (!q) return;
    this.router.navigate(['/clientes'], { queryParams: { q } });
  }
}
