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
import { ActivatedRoute } from '@angular/router';
import { ImageModule } from 'primeng/image';
import { BackendStatusService } from '../backend-status.service';
import { PresupuestoVisor } from '../models';
import { iconoFormaReferencia } from '../precio-referencia.util';
import { ShowroomService } from '../showroom.service';

/**
 * Visor read-only del armado de presupuestos, pensado para abrirse desde el
 * celular del cliente. A diferencia del {@code VisorPage} del showroom (que
 * muestra producto-a-producto), acá el cliente ve el CARRITO COMPLETO del
 * presupuesto — todos los ítems, el total y el desglose por formas de pago —
 * y se actualiza en vivo a medida que el operador lo arma. 100% lectura: no
 * permite editar ni quitar nada.
 *
 * <p>Se conecta al mismo canal SSE por token que el visor del showroom
 * ({@code /visor/{token}/events}) pero escucha solo el evento
 * {@code presupuesto-visor}. Hidrata el estado inicial con
 * {@code GET /visor/{token}/presupuesto} (el backend guarda el último
 * snapshot en memoria), así el celular que escanea el QR tarde ve el armado
 * actual sin esperar al próximo cambio.
 */
@Component({
  selector: 'app-visor-presupuesto-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, ImageModule],
  templateUrl: './visor-presupuesto-page.html',
  styleUrl: './visor-presupuesto-page.scss',
})
export class VisorPresupuestoPage {
  private readonly api = inject(ShowroomService);
  private readonly backendStatus = inject(BackendStatusService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly route = inject(ActivatedRoute);

  /** Token de la sesión de visor al que está ligado este visor — viene del path
   *  {@code /visor-presupuesto/:token}. Determina el canal SSE y de qué
   *  sesión hidratamos el snapshot. */
  readonly visorToken = this.route.snapshot.paramMap.get('token') ?? '';

  /** True cuando el token del path está vacío o no corresponde a una sesión
   *  activa (404/410 del backend — no encontrada o atención ya finalizada).
   *  Muestra el overlay "código inválido" — mismo patrón que el visor del
   *  showroom. */
  readonly operadorInvalido = signal(false);

  /** Último snapshot del presupuesto recibido (hidratación inicial + SSE).
   *  Null hasta que llega el primero. */
  readonly snapshot = signal<PresupuestoVisor | null>(null);

  readonly items = computed(() => this.snapshot()?.items ?? []);
  readonly hayItems = computed(() => this.items().length > 0);
  readonly total = computed(() => this.snapshot()?.total ?? 0);
  readonly formasPago = computed(() => this.snapshot()?.formasPago ?? []);

  /** Subtotal BRUTO (sin descuentos) = Σ precioUnitario × cantidad. */
  readonly subtotalBruto = computed(() =>
    this.items().reduce((acc, it) => acc + it.precioUnitario * it.cantidad, 0),
  );
  /** Monto descontado en total (bruto − total efectivo). */
  readonly descuentoMonto = computed(() => Math.max(0, this.subtotalBruto() - this.total()));
  /** % de descuento global sobre el subtotal bruto. */
  readonly descuentoPorcentaje = computed(() => {
    const bruto = this.subtotalBruto();
    return bruto > 0 ? (this.descuentoMonto() / bruto) * 100 : 0;
  });
  /** True si hay un descuento aplicado a mostrar (umbral de $1 para evitar
   *  ruido por redondeo). */
  readonly hayDescuento = computed(() => this.descuentoMonto() >= 1);

  /** Nombre del cliente, o null si vacío/blank — en ese caso el header muestra
   *  el encabezado genérico "Presupuesto". */
  readonly clienteNombre = computed(() => {
    const n = this.snapshot()?.clienteNombre?.trim();
    return n ? n : null;
  });

  /** Panel de formas de pago desplegado/colapsado. Colapsado por default: el
   *  TOTAL queda siempre visible en el footer fijo y las formas se ven con un
   *  toque, sin tener que scrollear todos los ítems. */
  readonly formasExpandidas = signal(false);

  constructor() {
    // Token faltante en la URL (alguien tipeó /visor-presupuesto/ a mano).
    if (!this.visorToken) {
      this.operadorInvalido.set(true);
      return;
    }
    // Engancha el SSE al canal de la sesión. Reusa el endpoint del visor del
    // showroom; solo nos interesa el evento presupuesto-visor.
    this.backendStatus.conectarComoVisor(this.visorToken);

    // Hidratación inicial: el snapshot actual del armado (o vacío). El 404/410
    // acá significa que el token del path no corresponde a una sesión activa
    // (no encontrada o atención ya finalizada).
    this.api.visorObtenerPresupuesto(this.visorToken).subscribe({
      next: (p) => this.snapshot.set(p),
      error: (err) => {
        if (err?.status === 404 || err?.status === 410) this.operadorInvalido.set(true);
      },
    });

    // Actualización en vivo: cada cambio publicado por el presupuestador.
    this.backendStatus.presupuestoVisorEvents$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((p) => this.snapshot.set(p));
  }

  /** Ícono PrimeNG para una forma de pago, inferido del nombre (efectivo,
   *  transferencia, cuotas/tarjeta…). Reusa el helper compartido. */
  iconoForma(nombre: string | null): string {
    return iconoFormaReferencia(nombre);
  }

  /** Precio por cuota para el desglose "N cuotas de $X". */
  precioPorCuota(precioFinal: number, cuotas: number | null): number {
    if (!cuotas || cuotas <= 1) return precioFinal;
    return precioFinal / cuotas;
  }
}
