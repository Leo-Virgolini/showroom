import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  model,
  output,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MessageService } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { ImageModule } from 'primeng/image';
import { InputNumberModule } from 'primeng/inputnumber';
import { TableModule } from 'primeng/table';
import { TooltipModule } from 'primeng/tooltip';
import { CambioPrecio, FormaPago, PresupuestoItem } from '../models';
import { PrecioPerfilService } from '../precio-perfil.service';
import { precioPorForma } from '../precio-referencia.util';
import { BackendStatusService } from '../backend-status.service';
import {
  ProductoGenericoData,
  ProductoGenericoDialog,
} from '../producto-generico-dialog/producto-generico-dialog';
import { seleccionarTextoAlEnfocar } from '../dom.utils';

/** Emitido tras cada mutación de {@link CarritoEditor.items} (agregar,
 *  modificar cantidad/descuento, quitar, vaciar, genérico). El host lo usa
 *  para marcar "cambios sin guardar" y mostrar su propio toast — el
 *  componente muestra el suyo con la MISMA data, así ninguno de los dos
 *  necesita conocer al otro (solo el evento). */
export interface CarritoMutacion {
  severity: 'success' | 'info' | 'warn';
  summary: string;
  detail: string;
}

/**
 * Editor del detalle de un presupuesto/pedido: tabla editable de ítems
 * (cantidad/descuento in-place, quitar, vaciar, orden) + alta de "producto
 * genérico" (SKU comodín de DUX para líneas que no están en catálogo).
 *
 * <p>El scan/búsqueda de productos TODAVÍA vive en el host ({@code
 * presupuestos-page}) — este componente solo edita la lista que ya tiene.
 * {@link focusScanInput} queda declarado para el contrato pero es un no-op
 * hasta que el scan se mueva acá (Fase 2 — Task 2).
 *
 * <p>{@link items} es un `model` two-way: el host la posee (la usa para
 * totales, formas de pago, payload y visor); este componente la muta
 * (agregar/quitar/vaciar reemplazan el array, cantidad/descuento mutan
 * in-place para no robarle el foco a `p-inputNumber`). Cada mutación además
 * emite {@link mutacion} para que el host marque "cambios sin guardar" y
 * replique el toast con su propio {@code MessageService}.
 *
 * <p>{@link formaPagoSeleccionada} y {@link cambiosPrecio} son inputs de solo
 * lectura que el host sigue poseyendo (selector global de forma de pago y
 * banner de precios desactualizados) — el componente los necesita para
 * pintar la columna "Precio"/"Subtotal" en la forma elegida y el pill de
 * precio desactualizado por fila.
 */
@Component({
  selector: 'app-carrito-editor',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    FormsModule,
    ButtonModule,
    ImageModule,
    InputNumberModule,
    TableModule,
    TooltipModule,
    ProductoGenericoDialog,
  ],
  templateUrl: './carrito-editor.html',
})
export class CarritoEditor {
  private readonly toast = inject(MessageService);
  private readonly precioPerfil = inject(PrecioPerfilService);
  private readonly backendStatus = inject(BackendStatusService);

  /** Lista de ítems — two-way con el host. Solo se reemplaza el array al
   *  AGREGAR o ELIMINAR ítems; cantidad/descuento mutan el objeto in-place
   *  (ver {@link itemsTick}). */
  readonly items = model<PresupuestoItem[]>([]);

  /** Forma de pago elegida en el toolbar del host (null = "Todas" / precio de
   *  referencia). Determina la columna "Precio"/"Subtotal" de la tabla. */
  readonly formaPagoSeleccionada = input<FormaPago | null>(null);

  /** Cambios de precio detectados por el host al cargar un presupuesto en
   *  edición (uid → {precioGuardado, precioActual}). Alimenta el pill "precio
   *  desactualizado" por fila. Vacío = todo al día (o modo creación). */
  readonly cambiosPrecio = input<ReadonlyMap<string, CambioPrecio>>(new Map());

  /** Emitido tras cada mutación de {@link items}, para que el host marque
   *  "cambios sin guardar" y replique el toast. */
  readonly mutacion = output<CarritoMutacion>();

  /** Emitido específicamente cuando {@link vaciar} corre — el host devuelve
   *  el foco al scan input de forma incondicional (mismo comportamiento que
   *  el `vaciar()` original, que llamaba `focusInput()` directo). */
  readonly vaciado = output<void>();

  /** Emitido cuando un dialog PROPIO del componente (por ahora, "Producto
   *  genérico") pasa de abierto a cerrado, por cualquier camino (confirmar,
   *  cancelar, ESC). El host todavía es dueño del scan input en esta tarea,
   *  así que no puede refocarlo por su cuenta — el original lo hacía con un
   *  effect unificado sobre `algunDialogAbierto()`; acá replicamos esa misma
   *  detección de transición, acotada al único dialog que vive en este
   *  componente. El host refoca con `focusInputAuto()` (respeta el guard
   *  táctil), igual que hacía ese effect. */
  readonly dialogCerrado = output<void>();

  /** SKU comodín de DUX para "Producto genérico" — expuesto por el backend
   *  vía /health. Null = el botón queda oculto (backend viejo). */
  readonly skuGenerico = this.backendStatus.skuProductoGenerico;

  /** Contador que se incrementa cuando un ítem se muta in-place (no cambia la
   *  referencia del array {@link items}). Uso interno del componente — el
   *  host tiene su PROPIO tick, independiente, que bumpea al recibir
   *  {@link mutacion}. */
  private readonly itemsTick = signal(0);

  /** Orden de visualización del detalle. `null` = orden de carga. Solo afecta
   *  el render — no depende de {@link itemsTick} a propósito: editar
   *  cantidad/descuento no debe reordenar la grilla en vivo. */
  readonly ordenItems = signal<{ campo: 'producto' | 'precio'; dir: 'asc' | 'desc' } | null>(null);

  /** Detalle ordenado para el render. Copia ordenada por descripción
   *  (producto) o por el precio de referencia mostrado. */
  readonly itemsOrdenados = computed<PresupuestoItem[]>(() => {
    const lista = this.items();
    const orden = this.ordenItems();
    if (!orden) return lista;
    const factor = orden.dir === 'asc' ? 1 : -1;
    return [...lista].sort((a, b) => {
      if (orden.campo === 'producto') {
        return (a.descripcion ?? '').localeCompare(b.descripcion ?? '', 'es', { sensitivity: 'base' }) * factor;
      }
      return (this.precioMostrado(a) - this.precioMostrado(b)) * factor;
    });
  });

  /** Cicla el orden del detalle para un campo: asc → desc → sin orden (carga). */
  ordenarItemsPor(campo: 'producto' | 'precio'): void {
    const actual = this.ordenItems();
    if (!actual || actual.campo !== campo) {
      this.ordenItems.set({ campo, dir: 'asc' });
    } else if (actual.dir === 'asc') {
      this.ordenItems.set({ campo, dir: 'desc' });
    } else {
      this.ordenItems.set(null);
    }
  }

  /** Ícono del encabezado de orden de un campo: flecha según dirección, o neutro. */
  iconoOrdenItems(campo: 'producto' | 'precio'): string {
    const o = this.ordenItems();
    if (!o || o.campo !== campo) return 'pi pi-sort-alt';
    return o.dir === 'asc' ? 'pi pi-sort-amount-up-alt' : 'pi pi-sort-amount-down';
  }

  /** True si el producto es de maquinaria (rubro configurable que cotiza sin
   *  IVA) — marca la fila con un badge/resaltado. */
  esRubroMaquinaria(rubro: string | null | undefined): boolean {
    return this.precioPerfil.rubroCotizaSinIva(rubro);
  }

  /** Precio de REFERENCIA unitario de un producto (forma destacada según el
   *  perfil de su rubro) — mismo criterio que scan/visor/showroom. */
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

  /** Precio unitario a MOSTRAR según la forma elegida en el host; con "Todas"
   *  cae al precio de referencia ({@link precioMostrado}). Solo visual. */
  precioVisualItem(it: {
    pvpKtGastroConIva: number | null;
    pvpKtGastroSinIva: number | null;
    porcIva?: number | null;
    rubro?: string | null;
  }): number {
    const forma = this.formaPagoSeleccionada();
    if (!forma) return this.precioMostrado(it);
    const perfil = this.precioPerfil.perfilForma(forma, this.esRubroMaquinaria(it.rubro));
    return precioPorForma(it.pvpKtGastroConIva, it.porcIva ?? null, perfil);
  }

  /** Subtotal por línea EN LA FORMA elegida (solo visual): precio visual ×
   *  (1 − desc) × cantidad. Con "Todas" coincide con el total efectivo. */
  subtotalVisualItem(it: PresupuestoItem): number {
    const desc = it.descuentoPorcentaje ?? 0;
    return this.precioVisualItem(it) * (1 - desc / 100) * it.cantidad;
  }

  /** Cambio de precio detectado para un ítem (por uid), o undefined si su
   *  precio sigue igual al guardado. Pinta el pill "precio desactualizado". */
  cambioPrecioDe(uid: string): CambioPrecio | undefined {
    return this.cambiosPrecio().get(uid);
  }

  /** Clase del input "% Desc." por línea: azul cuando la línea tiene
   *  descuento, neutro cuando es 0. */
  claseInputDescuentoItem(descuento: number | null | undefined): string {
    const base = 'text-center descuento-input';
    return (descuento ?? 0) > 0
      ? `${base} font-semibold text-sky-600 dark:text-sky-400`
      : `${base} text-muted-color`;
  }

  /** Selecciona el contenido del input al enfocarlo (el "0%" no se concatena
   *  al tipear). Lógica compartida en {@link seleccionarTextoAlEnfocar}. */
  protected readonly seleccionarAlEnfocar = seleccionarTextoAlEnfocar;

  /** Tope de cantidad para el input. NO se topea al stock: el operador puede
   *  cargar la cantidad que quiera; un pill amarillo avisa si excede el
   *  disponible. Cap alto solo para evitar cantidades absurdas. */
  cantidadMaximaDe(_it: PresupuestoItem): number {
    return 9999;
  }

  actualizarCantidad(it: PresupuestoItem, valor: number): void {
    if (!Number.isFinite(valor) || valor <= 0) valor = 1;
    if (it.cantidad === valor) return;
    const prev = it.cantidad;
    it.cantidad = valor;
    this.itemsTick.update((v) => v + 1);
    this.emitirMutacion('info', 'Cantidad actualizada',
      `${this.etiquetaItem(it)}: ${prev}u → ${valor}u`);
  }

  actualizarDescuento(it: PresupuestoItem, valor: number): void {
    if (!Number.isFinite(valor) || valor < 0) valor = 0;
    if (valor > 100) valor = 100;
    if ((it.descuentoPorcentaje ?? 0) === valor) return;
    it.descuentoPorcentaje = valor;
    this.itemsTick.update((v) => v + 1);
    this.emitirMutacion('info', 'Descuento actualizado',
      `${this.etiquetaItem(it)}: ${valor}%`);
  }

  /** Quita un ítem del detalle. NO toca el map de "cambios de precio" del
   *  host — el host lo purga solo (por uid vivo) vía un `effect`. */
  eliminarItem(uid: string): void {
    const it = this.items().find((x) => x.uid === uid);
    this.items.set(this.items().filter((x) => x.uid !== uid));
    if (it) {
      this.emitirMutacion('warn', 'Producto quitado', this.etiquetaItem(it));
    }
  }

  /** Vacía todo el detalle. Igual que {@link eliminarItem}, no toca el map de
   *  "cambios de precio" del host (se purga solo). Emite {@link vaciado} para
   *  que el host devuelva el foco al scan input. */
  vaciar(): void {
    const cantidad = this.items().length;
    this.items.set([]);
    this.vaciado.emit();
    if (cantidad > 0) {
      this.emitirMutacion('warn', 'Detalle vaciado',
        `Se quitaron ${cantidad} ${cantidad === 1 ? 'producto' : 'productos'}.`);
    }
  }

  // ============================================================
  // Producto genérico — alta a mano de una línea con el SKU comodín de DUX.
  // ============================================================
  readonly mostrarDialogGenerico = signal(false);

  constructor() {
    // Detecta la transición abierto→cerrado del dialog genérico (confirmar,
    // cancelar o ESC) y emite `dialogCerrado` para que el host refoque el
    // scan input — réplica acotada del effect unificado que tenía el host
    // sobre `algunDialogAbierto()` antes de este refactor.
    let habiaDialogAbierto = false;
    effect(() => {
      const abierto = this.mostrarDialogGenerico();
      if (habiaDialogAbierto && !abierto) {
        this.dialogCerrado.emit();
      }
      habiaDialogAbierto = abierto;
    });
  }

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
    this.emitirMutacion('success', 'Producto genérico agregado',
      `${this.etiquetaItem(nuevo)}${data.cantidad > 1 ? ` (${data.cantidad}u)` : ''}`);
  }

  /** Devuelve el foco al input de scan. En esta tarea el scan todavía vive en
   *  el host — no hay nada que enfocar acá. Task 2 lo implementa de verdad
   *  cuando el input de scan se mueva a este componente. */
  focusScanInput(): void {
    // no-op hasta Fase 2 - Task 2.
  }

  private warn(detail: string): void {
    this.toast.add({ severity: 'warn', summary: 'Atención', detail, life: 5000 });
  }

  /** Notifica al host una mutación. NO muestra un toast propio acá: el
   *  `MessageService` de esta app es un singleton único (provisto una sola
   *  vez en `app.ts`, ningún componente lo re-provee) — mostrar un toast acá
   *  Y otro en el host (`notificarMutacion`) duplicaría cada aviso en
   *  pantalla. El host es la única fuente del toast + `hayCambiosSinGuardar`. */
  private emitirMutacion(severity: 'success' | 'info' | 'warn', summary: string, detail: string): void {
    this.mutacion.emit({ severity, summary, detail });
  }

  /** Etiqueta corta del ítem para los toasts: descripción truncada o el SKU
   *  como fallback. */
  private etiquetaItem(it: { descripcion?: string | null; sku: string }): string {
    const desc = (it.descripcion ?? '').trim();
    if (!desc) return it.sku;
    return desc.length > 40 ? `${desc.slice(0, 40)}…` : desc;
  }
}
