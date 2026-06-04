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
import { ActivatedRoute } from '@angular/router';
import { MessageService } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { ImageModule } from 'primeng/image';
import { InputNumberModule } from 'primeng/inputnumber';
import { TagModule } from 'primeng/tag';
import { BackendStatusService } from '../backend-status.service';
import {
  EscalaDescuento,
  FormaPago,
  ScanResult,
  SesionShowroom,
  normalizarRubro,
} from '../models';
import { precioPorForma, iconoFormaReferencia } from '../precio-referencia.util';
import { ShowroomService } from '../showroom.service';

/**
 * Pantalla espejo del scan, pensada para abrir desde un celular y ver los
 * productos a medida que se escanean en el showroom. Uso primario: el
 * vendedor mientras camina por el showroom; secundariamente el cliente
 * puede mirarla también.
 *
 * <p>Cada vez que se escanea un producto desde la pantalla principal, el
 * backend publica un evento SSE {@code scan-visor} y esta página se
 * actualiza en tiempo real. Si el visor se conecta antes del primer scan,
 * queda en "esperando…". Además del modo lectura, expone un stepper +
 * botón "Agregar al carrito" para que el operador (o el cliente con su
 * teléfono) sume el producto al carrito server-side sin volver al puesto.
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
  private readonly route = inject(ActivatedRoute);
  private readonly toast = inject(MessageService);

  /** Username del operador al que está ligado este visor — viene del path
   *  {@code /visor/:username}. Determina a qué canal SSE nos conectamos y a
   *  qué carrito agrega items el botón "Agregar al carrito". */
  readonly operadorUsername = this.route.snapshot.paramMap.get('username') ?? '';

  /** True cuando el username del path está vacío, malformado o no corresponde
   *  a un operador activo (el backend devuelve 404). Muestra un overlay
   *  explicativo en lugar de la pantalla normal — sin esto, el visor quedaría
   *  pegado en "esperando…" sin que el cliente sepa por qué nunca recibe
   *  scans (típico: QR mal generado, operador deshabilitado en la consola). */
  readonly operadorInvalido = signal(false);

  /** Producto actualmente mostrado. {@code null} = pantalla "esperando…". */
  readonly ultimoScan = signal<ScanResult | null>(null);

  /** Código fallido cuando el operador escanea algo que no existe (404). Se
   *  muestra como overlay durante {@link ERROR_VISIBLE_MS} y luego se limpia
   *  automáticamente para volver al producto anterior o al estado "esperando".
   *  Sin esto el visor seguiría mostrando el último producto válido y el
   *  cliente pensaría que su código escaneó al producto que ve en pantalla. */
  readonly codigoErrado = signal<string | null>(null);
  private readonly ERROR_VISIBLE_MS = 6000;
  /** Handle del timer que limpia {@link codigoErrado} — guardamos la
   *  referencia para resetearlo si llega otro error consecutivo. */
  private errorTimer?: ReturnType<typeof setTimeout>;

  /** Nombre del cliente al que se está atendiendo. Null cuando no hay sesión
   *  activa — en ese caso el visor muestra el placeholder genérico. */
  readonly nombreCliente = signal<string | null>(null);

  /** Escalones de descuento. Se cargan al iniciar y son los mismos que usa
   *  la pantalla principal. Soporta N escalas (no sólo 2). */
  readonly escalas = signal<EscalaDescuento[]>([]);

  /** Todas las formas de pago activas. Se cargan al iniciar vía el endpoint
   *  público y se filtran a referencia con el computed de abajo. */
  readonly formasActivas = signal<FormaPago[]>([]);

  /** Formas marcadas como precio de referencia, por `orden`. */
  readonly formasReferencia = computed(() =>
    this.formasActivas()
      .filter((f) => f.precioReferencia)
      .sort((a, b) => (a.orden ?? 0) - (b.orden ?? 0)),
  );

  /** Primera forma de referencia (destacada), o null. */
  readonly formaReferenciaPrimaria = computed(() => this.formasReferencia()[0] ?? null);

  /** Formas de referencia secundarias (todas menos la destacada). */
  readonly formasReferenciaSecundarias = computed(() => this.formasReferencia().slice(1));

  /** Rubros cuyos productos cotizan sin IVA (precio base = PVP sin IVA). Se cargan
   *  al iniciar vía el endpoint público; default del backend = MAQUINAS INDUSTRIALES. */
  readonly rubrosSinIva = signal<string[]>([]);

  /** Set normalizado para comparar rubros sin importar acentos/casing. */
  private readonly rubrosSinIvaSet = computed(
    () => new Set(this.rubrosSinIva().map(normalizarRubro)),
  );

  /** True si el rubro cotiza sin IVA (su precio base es el PVP sin IVA). */
  rubroCotizaSinIva(rubro: string | null | undefined): boolean {
    const n = normalizarRubro(rubro);
    return n !== '' && this.rubrosSinIvaSet().has(n);
  }

  /** Cantidad seleccionada con el stepper antes de "Agregar al carrito". Se
   *  resetea a 1 cada vez que cambia el producto. */
  readonly cantidad = signal(1);

  /** True mientras la request al backend está en vuelo (evita doble-tap). */
  readonly enviandoAgregar = signal(false);

  /** Handles del auto-repeat al mantener presionado +/− — replica el
   *  comportamiento del stepper de PrimeNG sin abrir teclado virtual en mobile.
   *  Delay inicial 500ms, luego incrementa cada 60ms (acelera levemente al
   *  pasar de 20 ticks). */
  private repeatTimeout?: ReturnType<typeof setTimeout>;
  private repeatInterval?: ReturnType<typeof setInterval>;

  /** Último id de sesión visto vía SSE — sirve para detectar cuando la sesión
   *  cambia (cancel/abandon/nueva) y limpiar el ultimoScan, distinguiéndolo
   *  de los eventos de "mismo id" que dispara cada scan. */
  private previousSesionId: number | null = null;

  /** Escalas ordenadas asc por umbralMin — orden natural para mostrarlas
   *  como "comprá más para llegar al próximo descuento". */
  readonly escalasOrdenadas = computed(() =>
    [...this.escalas()].sort((a, b) => a.umbralMin - b.umbralMin),
  );

  /** True si el producto recién scaneado pertenece a un rubro excluido de los
   *  descuentos por escala (MAQUINAS INDUSTRIALES). El visor oculta los tiles
   *  "Comprá más y ahorrás" en ese caso — sino sugeriría precios que no
   *  aplican comercialmente para este tipo de producto. */
  readonly scanExcluyeDescuentos = computed(
    () => this.rubroCotizaSinIva(this.ultimoScan()?.rubro),
  );

  /** Producto vendible: con precio cargado y habilitado. El stock NO lo bloquea
   *  (lo respetan el operador y el backend al cerrar el pedido en DUX) —
   *  permitimos agregar items sin stock como pendiente de reposición. */
  readonly puedeAgregar = computed(() => {
    const r = this.ultimoScan();
    if (!r) return false;
    if (r.habilitado === false) return false;
    if (r.pvpKtGastroConIva == null || r.pvpKtGastroConIva <= 0) return false;
    return true;
  });

  /** Tope superior del stepper de cantidad. Si el stock no está confirmado
   *  o es 0, dejamos el máximo en 999 para que el cliente pueda elegir
   *  cualquier cantidad razonable (el ítem se agregará "forzado"). */
  readonly maxCantidad = computed(() => {
    const r = this.ultimoScan();
    return r?.stockTotal != null && r.stockTotal > 0 ? r.stockTotal : 999;
  });

  constructor() {
    // Username faltante en la URL (típico: alguien tipeó /visor/ a mano).
    // No intentamos conectar — el SSE quedaría con doble barra y daría 404.
    if (!this.operadorUsername) {
      this.operadorInvalido.set(true);
      return;
    }
    // Engancha el SSE del BackendStatusService al canal personal del operador
    // — sin esto este celular recibiría solo eventos globales (ningún scan).
    this.backendStatus.conectarComoVisor(this.operadorUsername);

    this.api.obtenerEscalasDescuento().subscribe({
      next: (lista) => this.escalas.set(lista),
      error: () => {
        /* sin escalas, sólo no se muestran los tiles de descuento */
      },
    });

    this.api.listarFormasPagoActivas().subscribe({
      next: (lista) => this.formasActivas.set(lista),
      error: () => {
        /* sin formas, el visor cae al precio lista en el display */
      },
    });

    this.api.obtenerRubrosSinIva().subscribe({
      next: (lista) => this.rubrosSinIva.set(lista),
      error: () => {
        /* sin lista, todos los rubros cotizan con IVA */
      },
    });

    this.backendStatus.scanVisorEvents$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((scan) => {
        // Un scan exitoso limpia cualquier error pendiente — el cliente
        // ya ve el nuevo producto válido en pantalla.
        this.limpiarError();
        this.ultimoScan.set(scan);
      });

    this.backendStatus.scanVisorErrorEvents$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((ev) => this.mostrarError(ev.codigo));

    // Hidratación inicial del nombre del cliente (sesión activa) + SSE para
    // que el visor se actualice cuando el operador inicia/cancela sesión.
    // Usamos el endpoint público por operador — el visor no está autenticado.
    // El error 404 acá significa que el username del path no corresponde a
    // un operador activo → mostramos el overlay de "URL inválida".
    this.api.visorObtenerSesionActiva(this.operadorUsername).subscribe({
      next: (s) => {
        this.nombreCliente.set(s.id != null ? s.nombre : null);
        this.previousSesionId = s.id ?? null;
      },
      error: (err) => {
        if (err?.status === 404) {
          this.operadorInvalido.set(true);
        }
        // Otros errores (500, network): queda en null y muestra header genérico.
      },
    });
    this.backendStatus.sesionEvents$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((s: SesionShowroom) => {
        this.nombreCliente.set(s.id != null ? s.nombre : null);
        // Cuando la sesión cambia (cancelada, abandonada o nueva), el producto
        // que ve el cliente anterior ya no es relevante — limpiamos el visor
        // para que el próximo cliente arranque con la pantalla "esperando…"
        // en vez de ver el producto del anterior. Detectamos transición por
        // cambio de id; los eventos de "mismo id" (registrarScan dispara uno
        // por cada scan) NO se consideran cambio.
        const currentId = s.id ?? null;
        if (currentId !== this.previousSesionId) {
          this.ultimoScan.set(null);
          this.previousSesionId = currentId;
        }
      });

    // Cada vez que cambia el producto, reseteamos la cantidad a 1.
    effect(() => {
      this.ultimoScan();
      this.cantidad.set(1);
    });

    this.destroyRef.onDestroy(() => {
      this.detenerStep();
      this.limpiarError();
    });
  }

  private mostrarError(codigo: string): void {
    this.codigoErrado.set(codigo);
    if (this.errorTimer) clearTimeout(this.errorTimer);
    this.errorTimer = setTimeout(() => {
      this.codigoErrado.set(null);
      this.errorTimer = undefined;
    }, this.ERROR_VISIBLE_MS);
  }

  private limpiarError(): void {
    if (this.errorTimer) {
      clearTimeout(this.errorTimer);
      this.errorTimer = undefined;
    }
    this.codigoErrado.set(null);
  }

  /** Botón "Entendido" del overlay — cierra el error manualmente. */
  cerrarError(): void {
    this.limpiarError();
  }

  /** Dispara un step inmediato y arranca el auto-repeat tras 500ms si el
   *  usuario sigue presionando. Llamado desde (pointerdown) en los botones. */
  iniciarStep(delta: 1 | -1): void {
    this.aplicarStep(delta);
    this.detenerStep();
    this.repeatTimeout = setTimeout(() => {
      this.repeatInterval = setInterval(() => this.aplicarStep(delta), 60);
    }, 500);
  }

  /** Frena el auto-repeat. Llamado desde pointerup/pointerleave/pointercancel. */
  detenerStep(): void {
    if (this.repeatTimeout) { clearTimeout(this.repeatTimeout); this.repeatTimeout = undefined; }
    if (this.repeatInterval) { clearInterval(this.repeatInterval); this.repeatInterval = undefined; }
  }

  /** Setter del input editable de cantidad. Clampa al rango [1, maxCantidad]
   *  para que el operador/cliente no pueda tipear un número fuera del stock. */
  actualizarCantidad(valor: number | null): void {
    const max = this.maxCantidad();
    let v = Number.isFinite(valor as number) ? (valor as number) : 1;
    if (v < 1) v = 1;
    if (v > max) v = max;
    this.cantidad.set(v);
  }

  private aplicarStep(delta: 1 | -1): void {
    const max = this.maxCantidad();
    const proximo = Math.max(1, Math.min(max, this.cantidad() + delta));
    if (proximo === this.cantidad()) {
      this.detenerStep();
      return;
    }
    this.cantidad.set(proximo);
  }

  /** Disparado por el botón "Agregar al carrito". Envía sku + cantidad al
   *  backend pasando el username del operador propietario del visor; el
   *  backend muta el carrito server-side de ESE operador y emite SSE
   *  `carrito-updated` en su canal personal. El response trae cuánto se
   *  sumó realmente — si fue menor a lo pedido (carrito ya al tope),
   *  mostramos warning al cliente con la cantidad real. */
  agregar(): void {
    const r = this.ultimoScan();
    if (!r || !this.puedeAgregar() || this.enviandoAgregar()) return;
    const cant = Math.max(1, Math.min(this.cantidad(), this.maxCantidad()));
    // forzar=true cuando el stock es 0 o desconocido: el backend acepta el
    // ítem como pendiente de reposición en vez de rechazarlo.
    const forzar = r.stockTotal == null || r.stockTotal <= 0;

    this.enviandoAgregar.set(true);
    this.api.visorAgregarAlCarrito(this.operadorUsername, r.sku, cant, forzar).subscribe({
      next: (res) => {
        this.enviandoAgregar.set(false);
        if (res.cantidadAgregada === 0) {
          this.toast.add({
            key: 'visor',
            severity: 'warn',
            summary: 'No se agregó al carrito',
            detail: res.motivo ?? `${r.sku}: el carrito ya tiene el stock completo.`,
            life: 6000,
          });
        } else if (forzar) {
          this.toast.add({
            key: 'visor',
            severity: 'warn',
            summary: 'Agregado sin stock',
            detail: `${r.sku} x${res.cantidadAgregada} — queda como pendiente de reposición.`,
            life: 4000,
          });
        } else if (res.recortado) {
          this.toast.add({
            key: 'visor',
            severity: 'warn',
            summary: 'No se agregó todo',
            detail: `${r.sku}: solo se sumaron ${res.cantidadAgregada} de ${res.cantidadPedida} (stock limitado).`,
            life: 6000,
          });
        } else {
          this.toast.add({
            key: 'visor',
            severity: 'success',
            summary: 'Agregado al carrito',
            detail: `${r.sku} x${res.cantidadAgregada}`,
            life: 2500,
          });
        }
        this.cantidad.set(1);
      },
      error: (err) => {
        this.enviandoAgregar.set(false);
        const detalle = (err as { error?: { message?: string } } | undefined)?.error?.message;
        this.toast.add({
          key: 'visor',
          severity: 'error',
          summary: 'No se pudo agregar',
          detail: detalle ?? 'No se pudo agregar al carrito. Reintentá en un momento.',
          life: 5000,
        });
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

  /** Recargo + aplicaIva del perfil (Normal o Maquinaria) de una forma según el
   *  rubro. Maquinaria: recargo null → cae al normal; aplicaIva null → false. */
  perfilForma(forma: FormaPago, esMaquinaria: boolean): { recargoPorcentaje: number | null; aplicaIva: boolean | null } {
    if (esMaquinaria) {
      return {
        recargoPorcentaje: forma.recargoPorcentajeMaquinaria ?? 0,
        aplicaIva: forma.aplicaIvaMaquinaria ?? false,
      };
    }
    return { recargoPorcentaje: forma.recargoPorcentaje, aplicaIva: forma.aplicaIva };
  }

  /** Precio de referencia de un producto para una forma de pago dada. Siempre
   *  parte del PVP con IVA; el perfil (Normal/Maquinaria) del rubro decide el
   *  recargo y si lleva IVA. */
  precioReferenciaPorForma(
    r: { pvpKtGastroConIva: number | null; pvpKtGastroSinIva: number | null; porcIva: number | null; rubro?: string | null },
    forma: FormaPago,
  ): number {
    const perfil = this.perfilForma(forma, this.rubroCotizaSinIva(r.rubro));
    return precioPorForma(r.pvpKtGastroConIva, r.porcIva, perfil);
  }

  /** Ícono PrimeNG para una forma de pago de referencia (inferido del nombre). */
  iconoPrecioReferencia(nombre: string): string {
    return iconoFormaReferencia(nombre);
  }

  /** True si el precio mostrado para esta forma incluye IVA, según el perfil del
   *  rubro: maquinaria usa `aplicaIvaMaquinaria` (null→false); el resto `aplicaIva`. */
  precioReferenciaTieneIva(
    r: { rubro?: string | null },
    forma: FormaPago,
  ): boolean {
    return this.perfilForma(forma, this.rubroCotizaSinIva(r.rubro)).aplicaIva ?? true;
  }

  /** Clases del badge c/IVA (verde) o s/IVA (ámbar). */
  badgeIvaClass(tieneIva: boolean): string {
    return tieneIva
      ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
      : 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300';
  }

  /** Precio de la forma primaria; sin formas marcadas cae al precio base según
   *  el rubro (PVP sin IVA para rubros sin IVA, con IVA el resto). */
  precioReferenciaPrimario(
    r: { pvpKtGastroConIva: number | null; porcIva: number | null; pvpKtGastroSinIva: number | null; rubro?: string | null },
  ): number {
    const f = this.formaReferenciaPrimaria();
    if (f) return this.precioReferenciaPorForma(r, f);
    return this.rubroCotizaSinIva(r.rubro)
      ? (r.pvpKtGastroSinIva ?? 0)
      : (r.pvpKtGastroConIva ?? r.pvpKtGastroSinIva ?? 0);
  }

  /** true si hay un escalón con umbral mayor (y por tanto mejor) que ya
   *  aplica al precio. Lo usamos para atenuar las tarjetas de escalones
   *  "menores" cuando un cliente ya califica para uno mejor. */
  haySuperior(precio: number, escala: EscalaDescuento): boolean {
    return this.escalasOrdenadas().some(
      (e) => e.umbralMin > escala.umbralMin && precio >= e.umbralMin,
    );
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
