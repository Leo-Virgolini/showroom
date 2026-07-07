import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { catchError, forkJoin, map, of } from 'rxjs';
import { MessageService } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { SelectModule } from 'primeng/select';
import { TooltipModule } from 'primeng/tooltip';
import { FormaPago, PedidoDetalle, PresupuestoItem } from '../models';
import { PrecioPerfilService } from '../precio-perfil.service';
import { BackendStatusService } from '../backend-status.service';
import { ShowroomService } from '../showroom.service';
import { pedidoItemsAPresupuestoItems } from '../pedido-a-carrito.util';
import { CarritoEditor, CarritoMutacion } from '../carrito-editor/carrito-editor';
import {
  CrearPedidoDialog,
  PedidoClientePrefill,
  PedidoItemEntrada,
} from '../crear-pedido-dialog/crear-pedido-dialog';
import { PageHeader } from '../page-header/page-header';
import { toastError } from '../toast.utils';
import { HasUnsavedChanges } from '../presupuestos-page/unsaved-changes.guard';

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
    ProgressSpinnerModule,
    SelectModule,
    TooltipModule,
    CarritoEditor,
    CrearPedidoDialog,
    PageHeader,
  ],
  templateUrl: './editar-pedido-page.html',
})
export class EditarPedidoPage implements HasUnsavedChanges {
  private readonly api = inject(ShowroomService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly precioPerfil = inject(PrecioPerfilService);
  private readonly backendStatus = inject(BackendStatusService);
  private readonly toast = inject(MessageService);

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

  /** Contador que se incrementa en cada mutación in-place (cantidad/descuento)
   *  del `carrito-editor` — fuerza el recompute de {@link total} sin necesidad
   *  de reemplazar el array `items` (mismo patrón que presupuestos-page). */
  private readonly itemsTick = signal(0);

  /** Ref al `carrito-editor` — para refocar el scan input tras cargar el
   *  pedido y tras cerrar sus propios diálogos. */
  readonly carrito = viewChild(CarritoEditor);

  /** Total en vivo con la forma de pago elegida — mismo cálculo que el
   *  footer de presupuestos-page ({@link PrecioPerfilService.precioVisualItem}
   *  por ítem, con el descuento individual de la línea aplicado encima). */
  readonly total = computed(() => {
    this.itemsTick();
    const forma = this.formaPagoSeleccionada();
    return this.items().reduce((acc, it) => {
      const precio = this.precioPerfil.precioVisualItem(it, forma);
      const desc = it.descuentoPorcentaje ?? 0;
      return acc + precio * it.cantidad * (1 - desc / 100);
    }, 0);
  });

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
      formaPagoId: p.formaPagoId ?? undefined,
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
    effect(() => {
      const formas = this.formasPago();
      const ped = this.pedido();
      if (this.formaResuelta() || !ped || formas.length === 0) return;
      const forma = formas.find((f) => f.id === ped.formaPagoId) ?? null;
      this.formaPagoSeleccionada.set(forma);
      this.formaResuelta.set(true);
    });
  }

  private cargarPedido(id: number): void {
    this.cargando.set(true);
    this.api.obtenerPedido(id).subscribe({
      next: (det) => {
        this.pedido.set(det);
        this.items.set(pedidoItemsAPresupuestoItems(det.items, this.backendStatus.skuProductoGenerico()));
        this.cargando.set(false);
        this.hayCambiosSinGuardar.set(false);
        this.carrito()?.focusScanInput();
        this.recotizarItemsViejos(det);
      },
      error: (err) => {
        this.cargando.set(false);
        toastError(this.toast, 'Editar pedido', err,
          'No se pudo cargar el pedido. Volvé al listado e intentá de nuevo.');
        this.router.navigate(['/pedidos']);
      },
    });
  }

  /** Pedidos anteriores a `precioListaConIva` no guardan el PVP de lista
   *  pre-forma original — `pedidoItemsAPresupuestoItems` ya los hidrató con
   *  el fallback aproximado (`precioUnitario`, que es POST-forma). Acá se
   *  re-cotizan esos ítems puntuales a la lista VIGENTE (best-effort, mismo
   *  `scan(sku, false)` que usa el presupuestador para no tocar el visor del
   *  cliente): si el scan falla o el SKU ya no existe, se deja el fallback
   *  aproximado sin romper la pantalla. Matchea por `uid` (no por índice)
   *  para no depender de que el array de {@link items} no haya cambiado
   *  mientras viajan los requests. */
  private recotizarItemsViejos(det: PedidoDetalle): void {
    const objetivos = det.items
      .map((it, i) => ({ uid: `${it.sku}-${i}`, sku: it.sku, precioListaConIva: it.precioListaConIva }))
      .filter((x) => x.precioListaConIva == null);
    if (objetivos.length === 0) return;

    const requests = objetivos.map(({ uid, sku }) =>
      this.api.scan(sku, false).pipe(
        map((res) => ({ uid, res })),
        catchError(() => of(null)),
      ),
    );
    forkJoin(requests).subscribe((resultados) => {
      let recotizo = false;
      this.items.update((arr) =>
        arr.map((item) => {
          const match = resultados.find((r) => r?.uid === item.uid);
          if (!match || match.res.pvpKtGastroConIva == null) return item;
          recotizo = true;
          return {
            ...item,
            pvpKtGastroConIva: match.res.pvpKtGastroConIva,
            pvpKtGastroSinIva: match.res.pvpKtGastroSinIva,
            porcIva: match.res.porcIva,
          };
        }),
      );
      if (recotizo) this.huboRecotizacion.set(true);
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

  volver(): void {
    this.router.navigate(['/pedidos']);
  }

  /** Implementa {@link HasUnsavedChanges} para el `unsavedChangesGuard`. */
  hasUnsavedChanges(): boolean {
    return this.hayCambiosSinGuardar();
  }
}
