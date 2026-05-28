import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { ConfirmationService, MessageService } from 'primeng/api';
import { AutoCompleteCompleteEvent, AutoCompleteModule } from 'primeng/autocomplete';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { DialogModule } from 'primeng/dialog';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { InputMaskModule } from 'primeng/inputmask';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { SelectModule } from 'primeng/select';
import { TextareaModule } from 'primeng/textarea';
import { ToolbarModule } from 'primeng/toolbar';
import { TooltipModule } from 'primeng/tooltip';
import {
  EnviarCotizacionRequest,
  FormaPago,
  GenerarCotizacionRequest,
  PresupuestoFormaPagoSnapshot,
} from '../models';
import { ShowroomService } from '../showroom.service';
import { BackendStatusService } from '../backend-status.service';
import { MoreMenu } from '../more-menu/more-menu';
import { toastError } from '../toast.utils';
import { UserChip } from '../user-chip/user-chip';

/** Redondeo HALF_UP a 2 decimales — alinea preview con el backend (BigDecimal). */
const redondearMoneda = (n: number): number => Math.round(n * 100) / 100;

const DOMINIOS_EMAIL_SUGERIDOS = [
  'gmail.com',
  'hotmail.com',
  'outlook.com',
  'yahoo.com.ar',
  'live.com',
  'icloud.com',
];

/**
 * Pantalla del cotizador de financiación: el operador ingresa un monto base
 * (sin IVA) y opcionalmente datos del cliente, y genera un PDF con todas
 * las formas de pago activas calculadas sobre ese monto.
 *
 * <p>Es una variante "rápida" del presupuestador — no tiene items ni
 * descuentos por línea. Una sola hoja de PDF, una sola tabla de formas.
 *
 * <p>Soporta modo edición igual que /presupuestos: al cargar con
 * {@code :id} en la URL, el form se pre-llena y "Generar" hace PUT en
 * lugar de POST.
 */
@Component({
  selector: 'app-cotizador-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    FormsModule,
    RouterLink,
    AutoCompleteModule,
    ButtonModule,
    CardModule,
    DialogModule,
    IconFieldModule,
    InputIconModule,
    InputMaskModule,
    InputNumberModule,
    InputTextModule,
    ProgressSpinnerModule,
    SelectModule,
    TextareaModule,
    ToolbarModule,
    TooltipModule,
    MoreMenu,
    UserChip,
  ],
  templateUrl: './cotizador-page.html',
  styleUrl: './cotizador-page.scss',
})
export class CotizadorPage {
  private readonly api = inject(ShowroomService);
  private readonly toast = inject(MessageService);
  private readonly confirmationService = inject(ConfirmationService);
  private readonly backendStatus = inject(BackendStatusService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly route = inject(ActivatedRoute);

  readonly screenLg = signal(
    typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches,
  );

  /** Modo edición: si la URL trae `:id`, lo cargamos y al guardar usamos PUT. */
  readonly cotizacionEditandoId = signal<number | null>(null);
  readonly cargandoEdicion = signal(false);
  readonly esModoEdicion = computed(() => this.cotizacionEditandoId() != null);

  // -----------------------------
  // Estado del cotizador
  // -----------------------------
  readonly montoBase = signal<number>(0);
  /** % de IVA aplicado a las formas que lo incluyen. Default 21 (tasa
   *  general AR) editable porque varía según el producto: 10.5 para
   *  esenciales, 27 para servicios públicos. */
  readonly porcIva = signal<number>(21);

  // Datos del cliente (todos opcionales — caso típico: cotización rápida
  // sin tener al cliente registrado todavía).
  readonly clienteNombre = signal('');
  readonly clienteTelefono = signal('');
  readonly clienteEmail = signal('');
  readonly sugerenciasEmail = signal<string[]>([]);
  readonly rubro = signal<string | null>(null);
  readonly rubroOtros = signal('');
  readonly observaciones = signal('');

  readonly opcionesRubro: { label: string; value: string }[] = [
    { label: 'Bar', value: 'bar' },
    { label: 'Restaurant', value: 'restaurant' },
    { label: 'Catering', value: 'catering' },
    { label: 'Cafetería', value: 'cafeteria' },
    { label: 'Panadería', value: 'panaderia' },
    { label: 'Pastelería', value: 'pasteleria' },
    { label: 'Otros…', value: 'otros' },
  ];

  readonly formasPago = signal<FormaPago[]>([]);

  readonly generandoPreview = signal(false);
  readonly enviandoEmail = signal(false);
  readonly mostrarDialogEnviar = signal(false);

  /** Tiene al menos un monto válido para cotizar. */
  readonly hayMonto = computed(() => (this.montoBase() ?? 0) > 0);

  /** Total CON IVA (base × (1 + IVA/100)) — para formas que aplican IVA. */
  readonly totalConIva = computed(() => {
    const base = this.montoBase() ?? 0;
    const iva = (this.porcIva() ?? 21) / 100;
    return base * (1 + iva);
  });

  /** Total SIN IVA — para formas que no aplican IVA. */
  readonly totalSinIva = computed(() => this.montoBase() ?? 0);

  /** Snapshots de las formas de pago con sus precios finales. Misma fórmula
   *  que el presupuestador: recargo se interpreta como descuento contado,
   *  precio = base / (1 - recargo/100). */
  readonly formasPagoCalculadas = computed<PresupuestoFormaPagoSnapshot[]>(() => {
    const baseConIva = this.totalConIva();
    const baseSinIva = this.totalSinIva();
    return this.formasPago().map((f) => {
      const recargo = (f.recargoPorcentaje ?? 0) / 100;
      const aplicaIva = f.aplicaIva ?? true;
      const base = aplicaIva ? baseConIva : baseSinIva;
      const precioFinal = redondearMoneda(base / (1 - recargo));
      return {
        id: f.id,
        nombre: f.nombre,
        recargoPorcentaje: f.recargoPorcentaje ?? 0,
        cantidadCuotas: f.cantidadCuotas,
        aplicaIva,
        precioFinal,
        descripcion: this.descripcionForma(f),
      };
    });
  });

  readonly indiceMejorPrecio = computed(() => {
    const formas = this.formasPagoCalculadas();
    if (formas.length <= 1) return -1;
    let idx = -1;
    let min: number | null = null;
    formas.forEach((f, i) => {
      if (f.precioFinal == null || f.precioFinal <= 0) return;
      if (f.monedaSimbolo) return;
      if (min == null || f.precioFinal < min) {
        min = f.precioFinal;
        idx = i;
      }
    });
    if (idx === -1 || min == null) return -1;
    const empates = formas.filter(
      (f) => f.precioFinal === min && !f.monedaSimbolo,
    ).length;
    return empates > 1 ? -1 : idx;
  });

  constructor() {
    this.api.listarFormasPagoActivas().subscribe({
      next: (formas) => this.formasPago.set(formas),
      error: () => this.formasPago.set([]),
    });

    // Toast del resultado del envío async.
    this.backendStatus.cotizacionEmailEvents$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((ev) => {
        if (ev.estado === 'SENT') {
          this.toast.add({
            severity: 'success',
            summary: 'Cotización enviada',
            detail: `#${ev.cotizacionId} → ${ev.email}`,
            life: 6000,
          });
        } else if (ev.estado === 'AMBIGUO') {
          this.toast.add({
            severity: 'warn',
            summary: 'Cotización probablemente enviada',
            detail: `#${ev.cotizacionId} → ${ev.email}: ${ev.error ?? 'Gmail tardó en confirmar.'}`,
            life: 10000,
          });
        } else {
          this.toast.add({
            severity: 'error',
            summary: 'No se pudo enviar la cotización',
            detail: `#${ev.cotizacionId} — ${ev.error ?? 'Error desconocido'}`,
            life: 8000,
          });
        }
      });

    // Si llega `:id` en la URL, modo edición.
    const idParam = this.route.snapshot.paramMap.get('id');
    if (idParam) {
      const id = Number(idParam);
      if (Number.isFinite(id) && id > 0) {
        this.cargarParaEditar(id);
      }
    }
  }

  private cargarParaEditar(id: number): void {
    this.cargandoEdicion.set(true);
    this.api.obtenerDetalleCotizacionFinanciera(id).subscribe({
      next: (det) => {
        this.cotizacionEditandoId.set(det.id);
        this.montoBase.set(det.montoBaseSinIva ?? 0);
        this.porcIva.set(det.porcIva ?? 21);
        this.clienteNombre.set(det.clienteNombre ?? '');
        this.clienteTelefono.set(det.clienteTelefono ?? '');
        this.clienteEmail.set(det.clienteEmail ?? '');
        this.observaciones.set(det.observaciones ?? '');
        const rubroGuardado = det.rubro ?? null;
        if (!rubroGuardado) {
          this.rubro.set(null);
          this.rubroOtros.set('');
        } else if (this.opcionesRubro.some((o) => o.value === rubroGuardado)) {
          this.rubro.set(rubroGuardado);
          this.rubroOtros.set('');
        } else {
          this.rubro.set('otros');
          this.rubroOtros.set(rubroGuardado);
        }
        this.cargandoEdicion.set(false);
      },
      error: (err) => {
        this.cargandoEdicion.set(false);
        toastError(this.toast, 'Editar', err,
          'No se pudo cargar la cotización. Volvé al historial e intentá de nuevo.');
      },
    });
  }

  private armarPayload(): GenerarCotizacionRequest {
    return {
      clienteNombre: this.clienteNombre().trim() || null,
      clienteTelefono: this.clienteTelefono().trim() || null,
      clienteEmail: this.clienteEmail().trim() || null,
      rubro: this.rubroFinal(),
      observaciones: this.observaciones().trim() || null,
      montoBaseSinIva: this.montoBase() ?? 0,
      porcIva: this.porcIva() ?? 21,
      formasPago: this.formasPagoCalculadas(),
    };
  }

  private rubroFinal(): string | null {
    const r = this.rubro();
    if (!r) return null;
    if (r === 'otros') {
      const libre = this.rubroOtros().trim();
      return libre || null;
    }
    return r;
  }

  vaciar(): void {
    this.montoBase.set(0);
    // IVA vuelve al default 21 — caso típico, el operador igual lo puede
    // ajustar después si la cotización es para un producto con otra tasa.
    this.porcIva.set(21);
    this.clienteNombre.set('');
    this.clienteTelefono.set('');
    this.clienteEmail.set('');
    this.rubro.set(null);
    this.rubroOtros.set('');
    this.observaciones.set('');
  }

  previsualizar(): void {
    if (!this.hayMonto()) {
      this.warn('Cargá un monto mayor a cero para cotizar.');
      return;
    }
    const editandoId = this.cotizacionEditandoId();
    const header = editandoId != null ? 'Guardar cambios' : 'Generar cotización';
    const message = editandoId != null
      ? `Se van a guardar los cambios de la cotización #${editandoId} y se descargará el PDF actualizado.`
      : `Se va a generar el PDF de la cotización por ${this.formatear(this.montoBase())} y quedará registrada en el historial.\n\n¿Continuar?`;

    this.confirmationService.confirm({
      header,
      message,
      icon: editandoId != null ? 'pi pi-save' : 'pi pi-file-pdf',
      acceptButtonProps: {
        label: editandoId != null ? 'Guardar cambios' : 'Generar y descargar',
        icon: editandoId != null ? 'pi pi-save' : 'pi pi-download',
      },
      rejectButtonProps: {
        label: 'Cancelar',
        severity: 'secondary',
        outlined: true,
      },
      accept: () => this.ejecutarPrevisualizar(),
    });
  }

  private ejecutarPrevisualizar(): void {
    const previewTab = window.open('about:blank', '_blank');
    this.generandoPreview.set(true);
    const editandoId = this.cotizacionEditandoId();
    const request$ = editandoId != null
      ? this.api.actualizarCotizacionFinanciera(editandoId, this.armarPayload())
      : this.api.previewCotizacionFinanciera(this.armarPayload());

    request$.subscribe({
      next: (res) => {
        this.generandoPreview.set(false);
        const blob = res.body;
        if (!blob) {
          if (previewTab) previewTab.close();
          this.warn('El backend no devolvió un PDF.');
          return;
        }
        const filename = this.extraerFilename(res.headers.get('Content-Disposition'));
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        if (previewTab) previewTab.location.href = url;
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
        this.toast.add({
          severity: 'success',
          summary: editandoId != null ? 'Cambios guardados' : 'Cotización generada',
          detail: editandoId != null
            ? `Cotización #${editandoId} actualizada y PDF descargado.`
            : 'Se descargó el PDF y se abrió para previsualizar.',
          life: 4000,
        });
      },
      error: (err) => {
        if (previewTab) previewTab.close();
        this.generandoPreview.set(false);
        toastError(this.toast, 'Cotización', err, 'No se pudo generar el PDF.');
      },
    });
  }

  abrirDialogEnviar(): void {
    if (!this.hayMonto()) {
      this.warn('Cargá un monto mayor a cero para cotizar.');
      return;
    }
    if (!this.validarEmailParaEnvio()) return;
    this.mostrarDialogEnviar.set(true);
  }

  enviarPorEmail(): void {
    if (!this.validarEmailParaEnvio()) return;
    const email = this.clienteEmail().trim();
    const payload: EnviarCotizacionRequest = {
      email,
      cotizacion: this.armarPayload(),
    };
    this.enviandoEmail.set(true);
    const editandoId = this.cotizacionEditandoId();
    const request$ = editandoId != null
      ? this.api.actualizarYEnviarCotizacionFinanciera(editandoId, payload)
      : this.api.enviarCotizacionFinanciera(payload);
    request$.subscribe({
      next: (res) => {
        this.enviandoEmail.set(false);
        this.mostrarDialogEnviar.set(false);
        this.toast.add({
          severity: 'info',
          summary: editandoId != null ? 'Cambios guardados — envío encolado' : 'Envío encolado',
          detail: `Cotización #${res.cotizacionId} → ${res.email}. El toast confirmará cuando salga.`,
          life: 5000,
        });
      },
      error: (err) => {
        this.enviandoEmail.set(false);
        toastError(this.toast, 'Enviar cotización', err,
          'No se pudo enviar la cotización.');
      },
    });
  }

  private validarEmailParaEnvio(): boolean {
    const email = this.clienteEmail().trim();
    if (!email) {
      this.warn('Falta el email del cliente.');
      return false;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      this.warn('El email del cliente no tiene un formato válido.');
      return false;
    }
    return true;
  }

  private warn(detail: string): void {
    this.toast.add({ severity: 'warn', summary: 'Atención', detail, life: 5000 });
  }

  onCompletarEmail(event: AutoCompleteCompleteEvent): void {
    const query = (event.query ?? '').trim();
    if (!query) {
      this.sugerenciasEmail.set([]);
      return;
    }
    const at = query.indexOf('@');
    if (at < 0) {
      this.sugerenciasEmail.set(DOMINIOS_EMAIL_SUGERIDOS.map((d) => `${query}@${d}`));
      return;
    }
    const localPart = query.substring(0, at);
    const dominioPart = query.substring(at + 1).toLowerCase();
    if (!localPart) {
      this.sugerenciasEmail.set([]);
      return;
    }
    if (dominioPart.includes('.') && !DOMINIOS_EMAIL_SUGERIDOS.some((d) => d.startsWith(dominioPart))) {
      this.sugerenciasEmail.set([]);
      return;
    }
    this.sugerenciasEmail.set(
      DOMINIOS_EMAIL_SUGERIDOS
        .filter((d) => d.startsWith(dominioPart))
        .map((d) => `${localPart}@${d}`),
    );
  }

  private extraerFilename(disposition: string | null): string {
    if (!disposition) return 'cotizacion.pdf';
    const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
    if (!m) return 'cotizacion.pdf';
    const raw = m[1].trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }

  // -----------------------------
  // Helpers de UI
  // -----------------------------
  iconoForma(nombre: string | null | undefined): string {
    const n = (nombre ?? '').toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (n.includes('efectivo')) return 'pi pi-money-bill';
    if (n.includes('usd') || n.includes('dolar')) return 'pi pi-dollar';
    if (n.includes('transferencia') || n.includes('deposito')) return 'pi pi-arrow-right-arrow-left';
    if (n.includes('cheque')) return 'pi pi-receipt';
    if (n.includes('mercadopago') || n.includes('mercado pago')) return 'pi pi-shopping-cart';
    if (n.includes('cuota')) return 'pi pi-calendar';
    if (n.includes('tarjeta') || n.includes('debito') || n.includes('credito')) return 'pi pi-credit-card';
    if (n.includes('remito')) return 'pi pi-file';
    return 'pi pi-tag';
  }

  private descripcionForma(f: FormaPago): string {
    const partes: string[] = [];
    if ((f.recargoPorcentaje ?? 0) < 0) {
      partes.push(`${Math.abs(f.recargoPorcentaje)}% de descuento`);
    }
    if ((f.cantidadCuotas ?? 1) > 1) {
      partes.push(`${f.cantidadCuotas} cuotas`);
    }
    return partes.join(' · ');
  }

  private formatear(n: number): string {
    return new Intl.NumberFormat('es-AR', {
      style: 'currency',
      currency: 'ARS',
      maximumFractionDigits: 0,
    }).format(n);
  }
}
