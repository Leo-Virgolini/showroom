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
import { MessageService } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { ImageModule } from 'primeng/image';
import { InputNumberModule } from 'primeng/inputnumber';
import { TagModule } from 'primeng/tag';
import { BackendStatusService } from '../backend-status.service';
import { EscalaDescuento, ScanResult } from '../models';
import { ShowroomService } from '../showroom.service';
import { toastError } from '../toast.utils';

/**
 * Pantalla espejo del scan, pensada para abrir desde un celular y ver los
 * productos a medida que se escanean en el showroom. Uso primario: el
 * vendedor mientras camina por el showroom; secundariamente el cliente
 * puede mirarla también.
 *
 * <p>Sin buscador, sin botones, sin carrito — sólo lectura. Cada vez que se
 * escanea un producto desde la pantalla principal, el backend publica un
 * evento SSE {@code scan-visor} y esta página se actualiza en tiempo real.
 * Si el visor se conecta antes del primer scan, queda en "esperando…".
 */
@Component({
  selector: 'app-visor-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, ButtonModule, ImageModule, InputNumberModule, TagModule],
  templateUrl: './visor-page.html',
  styleUrl: './visor-page.scss',
})
export class VisorPage {
  private readonly api = inject(ShowroomService);
  private readonly backendStatus = inject(BackendStatusService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly toast = inject(MessageService);

  /** Producto actualmente mostrado. {@code null} = pantalla "esperando…". */
  readonly ultimoScan = signal<ScanResult | null>(null);

  /** Escalones de descuento. Se cargan al iniciar y son los mismos que usa
   *  la pantalla principal. Soporta N escalas (no sólo 2). */
  readonly escalas = signal<EscalaDescuento[]>([]);

  /** Cantidad seleccionada con el stepper antes de "Agregar al carrito". Se
   *  resetea a 1 cada vez que cambia el producto. */
  readonly cantidad = signal(1);

  /** True mientras la request al backend está en vuelo (evita doble-tap). */
  readonly enviandoAgregar = signal(false);

  /** Escalas ordenadas asc por umbralMin — orden natural para mostrarlas
   *  como "comprá más para llegar al próximo descuento". */
  readonly escalasOrdenadas = computed(() =>
    [...this.escalas()].sort((a, b) => a.umbralMin - b.umbralMin),
  );

  /** Producto vendible: con precio cargado, habilitado y con stock > 0. Si no
   *  cumple alguno, no mostramos el stepper ni el botón. */
  readonly puedeAgregar = computed(() => {
    const r = this.ultimoScan();
    if (!r) return false;
    if (r.habilitado === false) return false;
    if (r.pvpKtGastroConIva == null || r.pvpKtGastroConIva <= 0) return false;
    if (r.stockTotal != null && r.stockTotal <= 0) return false;
    return true;
  });

  /** Tope superior del stepper de cantidad. Si el stock es null (no
   *  sincronizado), no limitamos — el backend valida al recibir. */
  readonly maxCantidad = computed(() => {
    const r = this.ultimoScan();
    return r?.stockTotal != null && r.stockTotal > 0 ? r.stockTotal : 9999;
  });

  constructor() {
    this.api.obtenerEscalasDescuento().subscribe({
      next: (lista) => this.escalas.set(lista),
      error: () => {
        /* sin escalas, sólo no se muestran los tiles de descuento */
      },
    });

    this.backendStatus.scanVisorEvents$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((scan) => this.ultimoScan.set(scan));

    // Si el operador rechazó/recortó un add que disparamos antes, el backend
    // emite este evento para que mostremos al cliente la cantidad real.
    // Filtramos por SKU del producto que el visor muestra ahora (sino, dos
    // visores en productos distintos verían toasts de adds ajenos).
    this.backendStatus.visorAddRejectedEvents$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((e) => {
        if (this.ultimoScan()?.sku !== e.sku) return;
        this.toast.add({
          severity: 'warn',
          summary: 'No se agregó todo',
          detail: e.agregada === 0
            ? `${e.sku}: el carrito ya tiene el stock completo (${e.intentada} no se sumaron).`
            : `${e.sku}: solo se agregaron ${e.agregada} de ${e.intentada} (stock limitado).`,
          life: 6000,
        });
      });

    // Cada vez que cambia el producto, reseteamos la cantidad a 1.
    effect(() => {
      this.ultimoScan();
      this.cantidad.set(1);
    });
  }

  /** Disparado por el botón "Agregar al carrito". Envía sku + cantidad al
   *  backend; éste valida y publica el evento SSE que actualiza la pantalla
   *  del operador. El visor solo muestra toast de confirmación o error. */
  agregar(): void {
    const r = this.ultimoScan();
    if (!r || !this.puedeAgregar() || this.enviandoAgregar()) return;
    const cant = Math.max(1, Math.min(this.cantidad(), this.maxCantidad()));

    this.enviandoAgregar.set(true);
    this.api.visorAgregarAlCarrito(r.sku, cant).subscribe({
      next: () => {
        this.enviandoAgregar.set(false);
        this.toast.add({
          severity: 'success',
          summary: 'Agregado al carrito',
          detail: `${r.sku} x${cant}`,
          life: 2500,
        });
        this.cantidad.set(1);
      },
      error: (err) => {
        this.enviandoAgregar.set(false);
        toastError(this.toast, 'No se pudo agregar', err,
          'No se pudo agregar al carrito. Reintentá en un momento.');
      },
    });
  }

  /** Monto que se ahorra el cliente por unidad al alcanzar un escalón. */
  ahorro(precio: number | null, porcentaje: number): number {
    if (precio == null) return 0;
    return (precio * porcentaje) / 100;
  }

  /** Precio final aplicando el descuento. */
  precioConDescuento(precio: number | null, porcentaje: number): number {
    if (precio == null) return 0;
    return precio - this.ahorro(precio, porcentaje);
  }

  /** true si hay un escalón con umbral mayor (y por tanto mejor) que ya
   *  aplica al precio. Lo usamos para atenuar las tarjetas de escalones
   *  "menores" cuando un cliente ya califica para uno mejor. */
  haySuperior(precio: number, escala: EscalaDescuento): boolean {
    return this.escalasOrdenadas().some(
      (e) => e.umbralMin > escala.umbralMin && precio >= e.umbralMin,
    );
  }

  /** Mejor escalón "alcanzado" — el de mayor umbral para el cual el precio
   *  ya califica. Devuelve null si ninguno aplica. */
  mejorAplicable(precio: number): EscalaDescuento | null {
    const aplicables = this.escalasOrdenadas().filter((e) => precio >= e.umbralMin);
    return aplicables.length > 0 ? aplicables[aplicables.length - 1] : null;
  }

  /**
   * Esquema de colores para el tile N (0-indexado). 5 colores distintos
   * (ámbar → esmeralda → cielo → violeta → rosa) y a partir del 6° cicla.
   * Las strings tienen que aparecer literales para que Tailwind JIT las pickee.
   */
  escalaColorScheme(i: number): {
    border: string;
    bg: string;
    pill: string;
    textTitle: string;
    textBig: string;
    textSmall: string;
    textItalic: string;
  } {
    return ESCALA_COLOR_SCHEMES[i % ESCALA_COLOR_SCHEMES.length];
  }
}

const ESCALA_COLOR_SCHEMES = [
  {
    border: 'border-amber-300 dark:border-amber-700',
    bg: 'bg-gradient-to-br from-amber-50 to-amber-100/50 dark:from-amber-950/40 dark:to-amber-900/20',
    pill: 'bg-amber-500',
    textTitle: 'text-amber-800 dark:text-amber-300',
    textBig: 'text-amber-700 dark:text-amber-300',
    textSmall: 'text-amber-700/80 dark:text-amber-300/80',
    textItalic: 'text-amber-800/70 dark:text-amber-300/70',
  },
  {
    border: 'border-emerald-400 dark:border-emerald-700',
    bg: 'bg-gradient-to-br from-emerald-50 to-emerald-100/50 dark:from-emerald-950/40 dark:to-emerald-900/20',
    pill: 'bg-emerald-600',
    textTitle: 'text-emerald-800 dark:text-emerald-300',
    textBig: 'text-emerald-700 dark:text-emerald-300',
    textSmall: 'text-emerald-700/80 dark:text-emerald-300/80',
    textItalic: 'text-emerald-800/70 dark:text-emerald-300/70',
  },
  {
    border: 'border-sky-400 dark:border-sky-700',
    bg: 'bg-gradient-to-br from-sky-50 to-sky-100/50 dark:from-sky-950/40 dark:to-sky-900/20',
    pill: 'bg-sky-600',
    textTitle: 'text-sky-800 dark:text-sky-300',
    textBig: 'text-sky-700 dark:text-sky-300',
    textSmall: 'text-sky-700/80 dark:text-sky-300/80',
    textItalic: 'text-sky-800/70 dark:text-sky-300/70',
  },
  {
    border: 'border-violet-400 dark:border-violet-700',
    bg: 'bg-gradient-to-br from-violet-50 to-violet-100/50 dark:from-violet-950/40 dark:to-violet-900/20',
    pill: 'bg-violet-600',
    textTitle: 'text-violet-800 dark:text-violet-300',
    textBig: 'text-violet-700 dark:text-violet-300',
    textSmall: 'text-violet-700/80 dark:text-violet-300/80',
    textItalic: 'text-violet-800/70 dark:text-violet-300/70',
  },
  {
    border: 'border-rose-400 dark:border-rose-700',
    bg: 'bg-gradient-to-br from-rose-50 to-rose-100/50 dark:from-rose-950/40 dark:to-rose-900/20',
    pill: 'bg-rose-600',
    textTitle: 'text-rose-800 dark:text-rose-300',
    textBig: 'text-rose-700 dark:text-rose-300',
    textSmall: 'text-rose-700/80 dark:text-rose-300/80',
    textItalic: 'text-rose-800/70 dark:text-rose-300/70',
  },
] as const;
