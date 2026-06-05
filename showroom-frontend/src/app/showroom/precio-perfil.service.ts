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
}
