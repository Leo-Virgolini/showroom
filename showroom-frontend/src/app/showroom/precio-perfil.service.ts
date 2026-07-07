import { Injectable, computed, inject, signal } from '@angular/core';
import { FormaPago, normalizarRubro } from './models';
import { ShowroomService } from './showroom.service';
import { FormaPagoCalc, perfilForma, precioPorForma } from './precio-referencia.util';

/**
 * Fuente única de las formas de pago activas + los rubros que cotizan sin IVA,
 * y de los helpers de "perfil por rubro" (menaje / maquinaria) que comparten el
 * scan/visor/carrito, presupuestos, cotizador e historial.
 *
 * <p>Antes cada componente cargaba los dos endpoints por su cuenta y
 * reimplementaba `perfilForma` / `formaDestacada` / `rubroCotizaSinIva`. Acá
 * viven una sola vez. Cada página llama {@link cargar} al entrar para reflejar
 * cambios hechos en /configuracion; dentro de una misma página los distintos
 * usos comparten el estado sin pedir de nuevo.
 */
@Injectable({ providedIn: 'root' })
export class PrecioPerfilService {
  private readonly api = inject(ShowroomService);

  /** Formas de pago activas (las del selector del operador). */
  readonly formasPago = signal<FormaPago[]>([]);

  /** Rubros que cotizan sin IVA (perfil maquinaria). */
  readonly rubrosSinIva = signal<string[]>([]);

  /** Set normalizado (sin acentos/casing) para comparar rubros. */
  private readonly rubrosSinIvaSet = computed(
    () => new Set(this.rubrosSinIva().map(normalizarRubro)),
  );

  /** Carga (o recarga) formas activas + rubros sin IVA. Idempotente: llamar al
   *  entrar a cada página para reflejar cambios de /configuracion. */
  cargar(): void {
    this.api.listarFormasPagoActivas().subscribe({
      next: (lista) => this.formasPago.set(lista),
      error: () => this.formasPago.set([]),
    });
    this.api.obtenerRubrosSinIva().subscribe({
      next: (lista) => this.rubrosSinIva.set(lista),
      error: () => this.rubrosSinIva.set([]),
    });
  }

  /** Setea formas activas + rubros sin IVA directamente (sin HTTP). Lo usa el
   *  visor, que recibe ambos en el bootstrap token-scoped en vez de pegarle a
   *  los endpoints globales (ahora autenticados). */
  setDatos(formas: FormaPago[], rubros: string[]): void {
    this.formasPago.set(formas ?? []);
    this.rubrosSinIva.set(rubros ?? []);
  }

  /** True si el rubro cotiza sin IVA (perfil maquinaria). */
  rubroCotizaSinIva(rubro: string | null | undefined): boolean {
    const n = normalizarRubro(rubro);
    return n !== '' && this.rubrosSinIvaSet().has(n);
  }

  /** Perfil (recargo + aplicaIva) de una forma según el rubro del producto. */
  perfilForma(forma: FormaPago, esMaquinaria: boolean): FormaPagoCalc {
    return perfilForma(forma, esMaquinaria);
  }

  /** Forma destacada (marcada "Precio ref.") del perfil, la de menor `orden`.
   *  Null si ninguna forma activa es referencia de ese perfil. */
  formaDestacada(esMaquinaria: boolean): FormaPago | null {
    return this.formasPago()
      .filter((f) => (esMaquinaria ? f.precioReferenciaMaquinaria : f.precioReferencia))
      .sort((a, b) => (a.orden ?? 0) - (b.orden ?? 0))[0] ?? null;
  }

  /** Precio unitario de un producto con una forma dada, según el perfil de su
   *  rubro (maquinaria s/IVA, resto c/IVA). */
  precioReferenciaPorForma(
    producto: { pvpKtGastroConIva: number | null; porcIva: number | null; rubro?: string | null },
    forma: FormaPago,
  ): number {
    const esMaq = this.rubroCotizaSinIva(producto.rubro);
    return precioPorForma(producto.pvpKtGastroConIva, producto.porcIva, perfilForma(forma, esMaq));
  }

  /** Precio de REFERENCIA de un producto: el de la forma de pago marcada como
   *  "Precio ref." (destacada) del perfil de su rubro. Por defecto esa forma es
   *  Efectivo (menaje c/IVA, maquinaria s/IVA), pero el nombre es "referencia"
   *  porque sigue a la forma destacada, no a "efectivo" literal. Si no hay forma
   *  destacada, cae al precio de lista por rubro. Es el precio único de
   *  referencia que se muestra en scan/visor/presupuestador/etiquetas. */
  precioReferencia(producto: {
    pvpKtGastroConIva: number | null;
    pvpKtGastroSinIva?: number | null;
    porcIva: number | null;
    rubro?: string | null;
  }): number {
    const esMaq = this.rubroCotizaSinIva(producto.rubro);
    const forma = this.formaDestacada(esMaq);
    if (forma) return this.precioReferenciaPorForma(producto, forma);
    return esMaq
      ? (producto.pvpKtGastroSinIva ?? 0)
      : (producto.pvpKtGastroConIva ?? producto.pvpKtGastroSinIva ?? 0);
  }

  /** True si el {@link precioReferencia} de un producto es un valor CON IVA
   *  (perfil menaje bajo la forma destacada), false si es SIN IVA (maquinaria).
   *  Se congela en el presupuesto para que, al transformarlo en pedido, el
   *  comprobante DUX facture con el MISMO perfil con que se cotizó — sin
   *  re-deducirlo (que cambiaría si después se modifica la lista de rubros sin
   *  IVA o la config de la forma de pago). */
  precioReferenciaConIva(producto: { porcIva?: number | null; rubro?: string | null }): boolean {
    const esMaq = this.rubroCotizaSinIva(producto.rubro);
    const forma = this.formaDestacada(esMaq);
    if (forma) return perfilForma(forma, esMaq).aplicaIva ?? !esMaq;
    // Sin forma destacada: el precio de referencia es el de lista por rubro
    // (menaje c/IVA, maquinaria s/IVA).
    return !esMaq;
  }

  /** Precio de REFERENCIA unitario a MOSTRAR en listas/tablas/visor (scan,
   *  carrito-editor, presupuestos-page): alias de {@link precioReferencia} con
   *  el shape suelto (`porcIva` opcional, `pvpKtGastroSinIva` puede faltar) que
   *  usan esos consumidores. Única fuente: antes esta reshape vivía duplicada
   *  como método privado en el host y en el componente. */
  precioMostrado(r: {
    pvpKtGastroConIva: number | null;
    pvpKtGastroSinIva: number | null;
    porcIva?: number | null;
    rubro?: string | null;
  }): number {
    return this.precioReferencia({
      pvpKtGastroConIva: r.pvpKtGastroConIva,
      pvpKtGastroSinIva: r.pvpKtGastroSinIva,
      porcIva: r.porcIva ?? null,
      rubro: r.rubro,
    });
  }

  /** Precio unitario a MOSTRAR según la forma de pago elegida por el operador
   *  en el toolbar (null = "Todas" → cae a {@link precioMostrado}, el precio
   *  de referencia). Antes esta lógica (perfil por rubro + `precioPorForma`)
   *  vivía duplicada en el host y en `carrito-editor`; ahora es la única
   *  fuente para la columna "Precio"/"Subtotal" en la forma seleccionada. */
  precioVisualItem(
    it: {
      pvpKtGastroConIva: number | null;
      pvpKtGastroSinIva: number | null;
      porcIva?: number | null;
      rubro?: string | null;
    },
    forma: FormaPago | null,
  ): number {
    if (!forma) return this.precioMostrado(it);
    const perfil = this.perfilForma(forma, this.rubroCotizaSinIva(it.rubro));
    return precioPorForma(it.pvpKtGastroConIva, it.porcIva ?? null, perfil);
  }
}
