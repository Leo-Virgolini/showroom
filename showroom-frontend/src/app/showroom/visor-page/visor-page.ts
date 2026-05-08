import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ImageModule } from 'primeng/image';
import { TagModule } from 'primeng/tag';
import { BackendStatusService } from '../backend-status.service';
import { EscalaDescuento, ScanResult } from '../models';
import { ShowroomService } from '../showroom.service';

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
  imports: [CommonModule, ImageModule, TagModule],
  templateUrl: './visor-page.html',
  styleUrl: './visor-page.scss',
})
export class VisorPage {
  private readonly api = inject(ShowroomService);
  private readonly backendStatus = inject(BackendStatusService);
  private readonly destroyRef = inject(DestroyRef);

  /** Producto actualmente mostrado. {@code null} = pantalla "esperando…". */
  readonly ultimoScan = signal<ScanResult | null>(null);

  /** Escalones de descuento para mostrar las tarjetas −5% / −10%. Se cargan
   *  al iniciar y son los mismos que usa la pantalla principal. */
  readonly escalas = signal<EscalaDescuento[]>([]);

  readonly umbral5 = computed(() => this.escalas()[0]?.umbralMin ?? 0);
  readonly umbral10 = computed(() => this.escalas()[1]?.umbralMin ?? 0);
  readonly porcentaje5 = computed(() => this.escalas()[0]?.porcentaje ?? 0);
  readonly porcentaje10 = computed(() => this.escalas()[1]?.porcentaje ?? 0);

  constructor() {
    this.api.obtenerEscalasDescuento().subscribe({
      next: (lista) => this.escalas.set(lista),
      error: () => {
        /* sin escalas, sólo no se muestran los tiles −5/−10 */
      },
    });

    this.backendStatus.scanVisorEvents$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((scan) => this.ultimoScan.set(scan));
  }

  /** Monto que se ahorra el cliente por unidad al alcanzar un escalón. */
  ahorro(precio: number | null, porcentaje: number): number {
    if (precio == null) return 0;
    return (precio * porcentaje) / 100;
  }
}
