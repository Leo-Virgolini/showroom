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
import { precioPorForma } from '../precio-referencia.util';
import { BackendStatusService } from '../backend-status.service';
import { abrirPdfEnPreview } from '../download.utils';
import { calcularSugerenciasEmail } from '../email-suggestions.utils';
import { toastError } from '../toast.utils';
import { TopActions } from '../top-actions/top-actions';

/** Redondeo HALF_UP a 2 decimales — alinea preview con el backend (BigDecimal). */
const redondearMoneda = (n: number): number => Math.round(n * 100) / 100;

/**
 * Pantalla del cotizador de financiación: el operador ingresa un monto base
 * (con IVA, igual que en scan/presupuesto) y opcionalmente datos del cliente,
 * y genera un PDF con todas las formas de pago activas calculadas sobre ese
 * monto. El cotizador deriva el neto cuando lo necesita.
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
    TopActions,
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
  //
  // El cotizador soporta DOS montos en simultáneo, cada uno con su tasa de
  // IVA propia, para cuando el operador cotiza productos con tasas
  // distintas (ej. una máquina con 21% + un insumo con 10.5%). Al menos
  // uno de los dos tiene que estar cargado; las formas de pago se calculan
  // sobre la suma respetando el IVA propio de cada monto.
  //
  // IMPORTANTE: los montos se cargan CON IVA (igual que en scan/presupuesto).
  // El neto se deriva cuando hace falta: monto / (1 + IVA/100).
  // -----------------------------
  /** Monto base 1 CON IVA — el operador lo carga con IVA incluido. */
  readonly montoBase = signal<number>(0);
  /** % de IVA aplicado a las formas que lo incluyen. Default 21 (tasa
   *  general AR) editable porque varía según el producto: 10.5 para
   *  esenciales, 27 para servicios públicos. */
  readonly porcIva = signal<number>(21);

  /** Segundo monto base CON IVA, opcional — 0 = no se usa. */
  readonly montoBase2 = signal<number>(0);
  /** % de IVA del segundo monto. Default 10.5 (productos esenciales). */
  readonly porcIva2 = signal<number>(10.5);

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

  /** Tiene al menos uno de los dos montos cargado. */
  readonly hayMonto = computed(
    () => (this.montoBase() ?? 0) > 0 || (this.montoBase2() ?? 0) > 0,
  );

  /** Total CON IVA — los montos ya vienen con IVA, así que es la suma
   *  directa. Es la base de las formas que aplican IVA. */
  readonly totalConIva = computed(
    () => (this.montoBase() ?? 0) + (this.montoBase2() ?? 0),
  );

  /** Total SIN IVA (neto) — derivado de los montos con IVA dividiendo cada
   *  uno por (1 + su IVA). Es la base de las formas que NO aplican IVA. */
  readonly totalSinIva = computed(() => {
    const m1 = this.montoBase() ?? 0;
    const iva1 = (this.porcIva() ?? 21) / 100;
    const m2 = this.montoBase2() ?? 0;
    const iva2 = (this.porcIva2() ?? 10.5) / 100;
    return m1 / (1 + iva1) + m2 / (1 + iva2);
  });

  /** Snapshots de las formas de pago con sus precios finales, calculados
   *  **por monto** con el perfil que corresponde a su tasa de IVA: 10,5% se
   *  cotiza como maquinaria (perfil maquinaria de la forma) y 21% como menaje
   *  (perfil normal). Cada monto usa {@link precioPorForma} con su perfil —
   *  igual criterio que scan/presupuesto, pero acá el "rubro" se deduce del IVA.
   *  El total de la forma es la suma de ambos montos. */
  readonly formasPagoCalculadas = computed<PresupuestoFormaPagoSnapshot[]>(() => {
    const m1 = this.montoBase() ?? 0;
    const iva1 = this.porcIva() ?? 21;
    const m2 = this.montoBase2() ?? 0;
    const iva2 = this.porcIva2() ?? 10.5;
    const esMaq1 = this.esMaquinariaPorIva(iva1);
    const esMaq2 = this.esMaquinariaPorIva(iva2);
    return this.formasPago().map((f) => {
      const p1 = m1 > 0 ? precioPorForma(m1, iva1, this.perfilForma(f, esMaq1)) : 0;
      const p2 = m2 > 0 ? precioPorForma(m2, iva2, this.perfilForma(f, esMaq2)) : 0;
      return {
        id: f.id,
        nombre: f.nombre,
        recargoPorcentaje: f.recargoPorcentaje ?? 0,
        cantidadCuotas: f.cantidadCuotas,
        aplicaIva: f.aplicaIva ?? true,
        precioFinal: redondearMoneda(p1 + p2),
        descripcion: this.descripcionForma(f),
      };
    });
  });

  /** En el cotizador el perfil se deduce de la TASA DE IVA del monto: 10,5% →
   *  maquinaria; el resto (21%) → menaje. */
  private esMaquinariaPorIva(iva: number | null): boolean {
    return Math.abs((iva ?? 21) - 10.5) < 0.01;
  }

  /** Recargo + aplicaIva del perfil (menaje/maquinaria) de una forma. Maquinaria:
   *  recargo null → 0 (no hereda del normal); aplicaIva null → false. */
  private perfilForma(
    forma: FormaPago,
    esMaquinaria: boolean,
  ): { recargoPorcentaje: number | null; aplicaIva: boolean | null } {
    return esMaquinaria
      ? {
          recargoPorcentaje: forma.recargoPorcentajeMaquinaria ?? 0,
          aplicaIva: forma.aplicaIvaMaquinaria ?? false,
        }
      : { recargoPorcentaje: forma.recargoPorcentaje, aplicaIva: forma.aplicaIva };
  }

  /** Clase CSS completa de cada card de forma de pago. Computamos la string
   *  en TS porque combinar `[class]="'color-N'"` con `[class.es-mejor-precio]`
   *  en el template hace que Angular pise el toggle de "mejor precio" al
   *  re-evaluar la expresión string, dejando la barra superior con el color
   *  del índice en lugar del verde. Una única string evita el conflicto. */
  clasesFormaCard(i: number): string {
    const colorClass = `color-${(i % 10) + 1}`;
    const mejorClass = i === this.indiceMejorPrecio() ? ' es-mejor-precio' : '';
    return `forma-pago-card ${colorClass}${mejorClass}`;
  }

  // ============================================================
  // Pago combinado: el cliente paga $X en una forma → cuánto le queda
  // por pagar en cada otra forma. Útil cuando el cliente quiere
  // adelantar parte del precio (ej. seña o pago en efectivo) y financiar
  // el resto.
  //
  // Lógica: la forma "elegida" representa el 100% de la cotización a un
  // precio total. Si el cliente paga $X de esos $totalForma, está cubriendo
  // una fracción `X / totalForma` del valor. Para CUALQUIER otra forma,
  // el restante a pagar = `(1 - fracción) × precioDeLaOtraForma`. Esto
  // funciona aunque las formas mezclen con-IVA y sin-IVA, porque cada
  // forma escala proporcionalmente con la cotización entera.
  // ============================================================

  /** Id de la forma de pago donde el cliente paga el "anticipo". Null = no
   *  hay pago combinado configurado, no se muestra el panel de restantes. */
  readonly pagoParcialFormaId = signal<number | null>(null);
  /** Monto que el cliente paga en la forma elegida. */
  readonly pagoParcialMonto = signal<number>(0);

  /** Datos del pago parcial activo o null si todavía no hay forma + monto
   *  válidos. {@code fraccionPagada} es lo que ya cubrió el cliente,
   *  entre 0 y 1. {@code restanteEnEsaForma} es lo que le falta pagar
   *  en la misma forma elegida (informativo). */
  readonly pagoParcial = computed(() => {
    const formaId = this.pagoParcialFormaId();
    const monto = this.pagoParcialMonto() ?? 0;
    if (formaId == null || monto <= 0) return null;
    const forma = this.formasPagoCalculadas().find(
      (f) => f.id === formaId,
    );
    if (!forma || forma.precioFinal <= 0) return null;
    // Sobrepasar el total NO es válido — el computed retorna null para que
    // el template muestre el mensaje de error y NO el grid de restantes
    // (que daría todos en $0 y confundiría al operador).
    if (monto > forma.precioFinal) return null;
    const fraccionPagada = monto / forma.precioFinal;
    return {
      forma,
      monto,
      fraccionPagada,
      fraccionRestante: 1 - fraccionPagada,
      restanteEnEsaForma: forma.precioFinal - monto,
    };
  });

  /** True si el operador ingresó un monto que supera el total de la forma
   *  seleccionada — la simulación no tiene sentido y el template muestra
   *  un error explicativo. */
  readonly pagoParcialExcedido = computed(() => {
    const formaId = this.pagoParcialFormaId();
    const monto = this.pagoParcialMonto() ?? 0;
    if (formaId == null || monto <= 0) return false;
    const forma = this.formasPagoCalculadas().find(
      (f) => f.id === formaId,
    );
    if (!forma || forma.precioFinal <= 0) return false;
    return monto > forma.precioFinal;
  });

  /** Total de la forma seleccionada — null si no hay forma elegida.
   *  Lo usa el template para sugerir un máximo y para el mensaje de error
   *  cuando el operador se pasa. */
  readonly pagoParcialTotalForma = computed(() => {
    const formaId = this.pagoParcialFormaId();
    if (formaId == null) return null;
    const forma = this.formasPagoCalculadas().find(
      (f) => f.id === formaId,
    );
    return forma?.precioFinal ?? null;
  });

  /** Lista de las demás formas con el restante calculado. Cuando hay pago
   *  parcial activo, el template usa esto para mostrar las cards "te queda
   *  $X en cada una de estas formas". */
  readonly pagoParcialRestantes = computed(() => {
    const pp = this.pagoParcial();
    if (!pp) return [];
    return this.formasPagoCalculadas()
      .filter((f) => f.id !== pp.forma.id)
      .map((f) => ({
        ...f,
        restante: redondearMoneda(f.precioFinal * pp.fraccionRestante),
      }));
  });

  /** Forma de pago que el operador puede ofrecer al cliente como
   *  "anticipo" (típicamente Efectivo). Solo nombre + id — el precio total
   *  ya está visible en las cards de arriba, no hace falta repetirlo en el
   *  dropdown porque agregaba ruido visual. */
  readonly formasPagoOpcionesParcial = computed(() => {
    return this.formasPagoCalculadas().map((f) => ({
      label: f.nombre,
      value: f.id,
      precioFinal: f.precioFinal,
    }));
  });

  /** Limpia el pago parcial — se invoca al cambiar montoBase o al
   *  presionar "vaciar" para que el panel no muestre datos stale. */
  limpiarPagoParcial(): void {
    this.pagoParcialFormaId.set(null);
    this.pagoParcialMonto.set(0);
  }

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
        this.montoBase.set(det.montoBaseConIva ?? 0);
        this.porcIva.set(det.porcIva ?? 21);
        this.montoBase2.set(det.montoBaseConIva2 ?? 0);
        this.porcIva2.set(det.porcIva2 ?? 10.5);
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
    const m2 = this.montoBase2() ?? 0;
    return {
      clienteNombre: this.clienteNombre().trim() || null,
      clienteTelefono: this.clienteTelefono().trim() || null,
      clienteEmail: this.clienteEmail().trim() || null,
      rubro: this.rubroFinal(),
      observaciones: this.observaciones().trim() || null,
      montoBaseConIva: this.montoBase() ?? 0,
      porcIva: this.porcIva() ?? 21,
      // Mandamos el segundo monto solo cuando está cargado — el backend lo
      // toma como "no se usa el segundo monto" si viene null/0.
      montoBaseConIva2: m2 > 0 ? m2 : null,
      porcIva2: m2 > 0 ? (this.porcIva2() ?? 10.5) : null,
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
    this.montoBase2.set(0);
    this.porcIva2.set(10.5);
    this.clienteNombre.set('');
    this.clienteTelefono.set('');
    this.clienteEmail.set('');
    this.rubro.set(null);
    this.rubroOtros.set('');
    this.observaciones.set('');
    this.limpiarPagoParcial();
  }

  previsualizar(): void {
    if (!this.hayMonto()) {
      this.warn('Cargá un monto mayor a cero para cotizar.');
      return;
    }
    const editandoId = this.cotizacionEditandoId();
    const header = editandoId != null ? 'Guardar cambios' : 'Generar cotización';
    const message = editandoId != null
      ? `Se van a guardar los cambios de la cotización #${editandoId} y se abrirá el PDF actualizado.`
      : `Se va a generar el PDF de la cotización por ${this.formatear(this.totalConIva())} y quedará registrada en el historial.\n\n¿Continuar?`;

    this.confirmationService.confirm({
      header,
      message,
      icon: editandoId != null ? 'pi pi-save' : 'pi pi-file-pdf',
      acceptButtonProps: {
        label: editandoId != null ? 'Guardar cambios' : 'Generar PDF',
        icon: editandoId != null ? 'pi pi-save' : 'pi pi-file-pdf',
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
        const resultado = abrirPdfEnPreview(res, 'cotizacion.pdf', previewTab);
        if (resultado == null) {
          this.warn('El backend no devolvió un PDF.');
          return;
        }
        const detallePreview = editandoId != null
          ? `Cotización #${editandoId} actualizada — se abrió para previsualizar.`
          : 'Se abrió para previsualizar. Podés bajar el PDF desde el visor.';
        const detalleDescarga = editandoId != null
          ? `Cotización #${editandoId} actualizada — PDF descargado (el browser bloqueó la pestaña preview).`
          : 'PDF descargado — el browser bloqueó la pestaña preview.';
        this.toast.add({
          severity: 'success',
          summary: editandoId != null ? 'Cambios guardados' : 'Cotización generada',
          detail: resultado.previewAbierto ? detallePreview : detalleDescarga,
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
    this.sugerenciasEmail.set(calcularSugerenciasEmail(event.query));
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
