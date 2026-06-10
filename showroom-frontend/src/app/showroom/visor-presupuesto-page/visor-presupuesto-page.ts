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
import { ShowroomService } from '../showroom.service';

/**
 * Visor read-only del armado de presupuestos, pensado para abrirse desde el
 * celular del cliente. A diferencia del {@code VisorPage} del showroom (que
 * muestra producto-a-producto), acá el cliente ve el CARRITO COMPLETO del
 * presupuesto — todos los ítems, el total y el desglose por formas de pago —
 * y se actualiza en vivo a medida que el operador lo arma. 100% lectura: no
 * permite editar ni quitar nada.
 *
 * <p>Se conecta al mismo canal SSE por operador que el visor del showroom
 * ({@code /visor/{username}/events}) pero escucha solo el evento
 * {@code presupuesto-visor}. Hidrata el estado inicial con
 * {@code GET /visor/{username}/presupuesto} (el backend guarda el último
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

  /** Username del operador al que está ligado este visor — viene del path
   *  {@code /visor-presupuesto/:username}. Determina el canal SSE y de qué
   *  operador hidratamos el snapshot. */
  readonly operadorUsername = this.route.snapshot.paramMap.get('username') ?? '';

  /** True cuando el username del path está vacío o no corresponde a un operador
   *  activo (404 del backend). Muestra el overlay "URL inválida" — mismo patrón
   *  que el visor del showroom. */
  readonly operadorInvalido = signal(false);

  /** Último snapshot del presupuesto recibido (hidratación inicial + SSE).
   *  Null hasta que llega el primero. */
  readonly snapshot = signal<PresupuestoVisor | null>(null);

  readonly items = computed(() => this.snapshot()?.items ?? []);
  readonly hayItems = computed(() => this.items().length > 0);
  readonly total = computed(() => this.snapshot()?.total ?? 0);
  readonly formasPago = computed(() => this.snapshot()?.formasPago ?? []);

  /** Nombre del cliente, o null si vacío/blank — en ese caso el header muestra
   *  el encabezado genérico "Presupuesto". */
  readonly clienteNombre = computed(() => {
    const n = this.snapshot()?.clienteNombre?.trim();
    return n ? n : null;
  });

  constructor() {
    // Username faltante en la URL (alguien tipeó /visor-presupuesto/ a mano).
    if (!this.operadorUsername) {
      this.operadorInvalido.set(true);
      return;
    }
    // Engancha el SSE al canal personal del operador. Reusa el endpoint del
    // visor del showroom; solo nos interesa el evento presupuesto-visor.
    this.backendStatus.conectarComoVisor(this.operadorUsername);

    // Hidratación inicial: el snapshot actual del armado (o vacío). El 404 acá
    // significa que el username del path no es un operador válido.
    this.api.visorObtenerPresupuesto(this.operadorUsername).subscribe({
      next: (p) => this.snapshot.set(p),
      error: (err) => {
        if (err?.status === 404) this.operadorInvalido.set(true);
      },
    });

    // Actualización en vivo: cada cambio publicado por el presupuestador.
    this.backendStatus.presupuestoVisorEvents$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((p) => this.snapshot.set(p));
  }

  /** Precio por cuota para el desglose "N cuotas de $X". */
  precioPorCuota(precioFinal: number, cuotas: number | null): number {
    if (!cuotas || cuotas <= 1) return precioFinal;
    return precioFinal / cuotas;
  }

  /** Formatea un monto en pesos sin decimales (mismo criterio visual que el
   *  resto del showroom: "$ 12.345"). */
  formatMoneda(n: number | null | undefined): string {
    const v = typeof n === 'number' && Number.isFinite(n) ? n : 0;
    return new Intl.NumberFormat('es-AR', {
      style: 'currency',
      currency: 'ARS',
      maximumFractionDigits: 0,
    }).format(v);
  }
}
