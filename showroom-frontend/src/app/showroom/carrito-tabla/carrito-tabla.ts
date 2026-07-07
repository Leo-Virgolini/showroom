import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  model,
  output,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { ImageModule } from 'primeng/image';
import { InputNumberModule } from 'primeng/inputnumber';
import { TableModule } from 'primeng/table';
import { TooltipModule } from 'primeng/tooltip';
import { CambioPrecio, CarritoMutacion, FormaPago, PresupuestoItem } from '../models';
import { PrecioPerfilService } from '../precio-perfil.service';
import { seleccionarTextoAlEnfocar } from '../dom.utils';
import { etiquetaItem } from '../item-etiqueta.util';

/**
 * Tabla editable del detalle de un presupuesto/pedido: muestra los ítems
 * agregados con cantidad/descuento in-place, quitar por fila, vaciar todo y
 * orden por producto/precio. Es la mitad "tabla" del viejo `carrito-editor`
 * (la otra mitad, scan/búsqueda + alta, vive en `carrito-buscador`).
 *
 * <p>{@link items} es un `model` two-way que POSEE el host y comparte con
 * `carrito-buscador` (el buscador agrega, esta tabla edita/quita). Cada mutación
 * emite {@link mutacion} para que el host marque "cambios sin guardar" y muestre
 * el toast. {@link vaciar} además emite {@link vaciado} para que el host devuelva
 * el foco al scan input (que vive en `carrito-buscador`, en otra columna).
 */
@Component({
  selector: 'app-carrito-tabla',
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
  ],
  templateUrl: './carrito-tabla.html',
})
export class CarritoTabla {
  private readonly precioPerfil = inject(PrecioPerfilService);

  /** Lista de ítems — two-way con el host, compartida con `carrito-buscador`.
   *  Solo se reemplaza el array al ELIMINAR/vaciar; cantidad/descuento mutan el
   *  objeto in-place (el propio evento de input dispara la CD y refresca la
   *  fila — no hace falta un tick propio; el host sí tiene el suyo para sus
   *  `computed` de totales). */
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

  /** Emitido al vaciar el detalle: el host devuelve el foco al scan input del
   *  `carrito-buscador` (la pistola QR debe seguir escaneando). */
  readonly vaciado = output<void>();

  /** Orden de visualización del detalle. `null` = orden de carga. Solo afecta
   *  el render — no depende de la mutación in-place a propósito: editar
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
   *  perfil de su rubro) — mismo criterio que scan/visor/showroom. Delega en
   *  el servicio compartido (única fuente, ver {@link PrecioPerfilService.precioMostrado}). */
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

  /** Precio unitario a MOSTRAR según la forma elegida en el host; con "Todas"
   *  cae al precio de referencia ({@link precioMostrado}). Solo visual. Delega
   *  en el servicio compartido (única fuente, ver
   *  {@link PrecioPerfilService.precioVisualItem}). */
  precioVisualItem(it: {
    pvpKtGastroConIva: number | null;
    pvpKtGastroSinIva: number | null;
    porcIva?: number | null;
    rubro?: string | null;
  }): number {
    return this.precioPerfil.precioVisualItem(it, this.formaPagoSeleccionada());
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
    this.emitirMutacion('info', 'Cantidad actualizada',
      `${etiquetaItem(it)}: ${prev}u → ${valor}u`);
  }

  actualizarDescuento(it: PresupuestoItem, valor: number): void {
    if (!Number.isFinite(valor) || valor < 0) valor = 0;
    if (valor > 100) valor = 100;
    if ((it.descuentoPorcentaje ?? 0) === valor) return;
    it.descuentoPorcentaje = valor;
    this.emitirMutacion('info', 'Descuento actualizado',
      `${etiquetaItem(it)}: ${valor}%`);
  }

  /** Quita un ítem del detalle. NO toca el map de "cambios de precio" del
   *  host — el host lo purga solo (por uid vivo) vía un `effect`. */
  eliminarItem(uid: string): void {
    const it = this.items().find((x) => x.uid === uid);
    this.items.set(this.items().filter((x) => x.uid !== uid));
    if (it) {
      this.emitirMutacion('warn', 'Producto quitado', etiquetaItem(it));
    }
  }

  /** Vacía todo el detalle. Igual que {@link eliminarItem}, no toca el map de
   *  "cambios de precio" del host (se purga solo). Emite {@link vaciado} para
   *  que el host devuelva el foco al scan input del buscador. */
  vaciar(): void {
    const cantidad = this.items().length;
    this.items.set([]);
    this.vaciado.emit();
    if (cantidad > 0) {
      this.emitirMutacion('warn', 'Detalle vaciado',
        `Se quitaron ${cantidad} ${cantidad === 1 ? 'producto' : 'productos'}.`);
    }
  }

  /** Notifica al host una mutación. NO muestra un toast propio acá: el
   *  `MessageService` de esta app es un singleton único (provisto una sola
   *  vez en `app.ts`) — el host es la única fuente del toast + `hayCambiosSinGuardar`. */
  private emitirMutacion(severity: 'success' | 'info' | 'warn', summary: string, detail: string): void {
    this.mutacion.emit({ severity, summary, detail });
  }
}
