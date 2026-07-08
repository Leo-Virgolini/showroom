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
} from '../models';
import {
  hayEscalonSuperior,
  iconoFormaReferencia,
  ordenarEscalasPorUmbral,
} from '../precio-referencia.util';
import { PrecioPerfilService } from '../precio-perfil.service';
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
  private readonly precioPerfil = inject(PrecioPerfilService);

  /** Token de la sesión de atención — viene del path {@code /visor/:token}.
   *  Determina el canal SSE y el carrito al que agrega el botón. */
  readonly visorToken = this.route.snapshot.paramMap.get('token') ?? '';

  /** True cuando el token del path está vacío, malformado o no corresponde
   *  a una sesión activa (el backend devuelve 404/410). Muestra un overlay
   *  explicativo en lugar de la pantalla normal — sin esto, el visor quedaría
   *  pegado en "esperando…" sin que el cliente sepa por qué nunca recibe
   *  scans (típico: QR mal generado, atención finalizada). */
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
   *  público. La forma destacada por perfil se resuelve con {@link formaDestacada}. */
  readonly formasActivas = this.precioPerfil.formasPago;

  /** Id de la forma elegida por el operador en el scan, recibido vía SSE
   *  `visor-forma`. Sticky: se mantiene hasta que llegue otro. Null = todavía
   *  no recibió ninguna → se usa la forma destacada del rubro. */
  readonly formaVisorId = signal<number | null>(null);

  /** Forma destacada/default para el perfil del producto: de las formas activas
   *  marcadas como referencia de ese perfil (menaje → `precioReferencia`;
   *  maquinaria → `precioReferenciaMaquinaria`), la de menor `orden`. Null si
   *  ninguna marcada. Mismo criterio que el scan/presupuestador. */
  formaDestacada(esMaquinaria: boolean): FormaPago | null {
    return this.precioPerfil.formaDestacada(esMaquinaria);
  }

  /** Forma EFECTIVA del visor = la de `formasActivas()` cuyo id == `formaVisorId()`,
   *  o la destacada del perfil del producto escaneado si no recibió ninguna. */
  readonly formaVisorEfectiva = computed<FormaPago | null>(() => {
    const id = this.formaVisorId();
    if (id != null) {
      const match = this.formasActivas().find((f) => f.id === id);
      if (match) return match;
    }
    return this.formaDestacada(this.rubroCotizaSinIva(this.ultimoScan()?.rubro));
  });

  /** True si la forma efectiva del visor es la más barata para el producto
   *  mostrado — habilita la pill "MEJOR PRECIO". */
  readonly formaVisorEsMasBarata = computed(() => {
    const r = this.ultimoScan();
    const forma = this.formaVisorEfectiva();
    if (!r || !forma) return false;
    const formas = this.formasActivas();
    if (formas.length < 2) return false;
    const precioForma = this.precioReferenciaPorForma(r, forma);
    return formas.every((f) => this.precioReferenciaPorForma(r, f) >= precioForma);
  });

  /** True si el rubro cotiza sin IVA (su precio base es el PVP sin IVA). */
  rubroCotizaSinIva(rubro: string | null | undefined): boolean {
    return this.precioPerfil.rubroCotizaSinIva(rubro);
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
    ordenarEscalasPorUmbral(this.escalas()),
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

  /** Tope superior del stepper de cantidad. NO se topea al stock: se permite
   *  pedir más de lo disponible (el excedente queda como pendiente de
   *  reposición y el ítem se agrega "forzado"). Cap alto solo para evitar
   *  cantidades absurdas. */
  readonly maxCantidad = computed(() => 9999);

  /** True cuando la cantidad elegida supera el stock disponible. Solo para un
   *  aviso INFORMATIVO (no bloquea agregar). */
  readonly superaStock = computed(() => {
    const r = this.ultimoScan();
    return r?.stockTotal != null && r.stockTotal > 0 && this.cantidad() > r.stockTotal;
  });

  constructor() {
    // Token faltante en la URL (típico: alguien tipeó /visor/ a mano).
    // No intentamos conectar — el SSE quedaría con doble barra y daría 404.
    if (!this.visorToken) {
      this.operadorInvalido.set(true);
      return;
    }
    // Engancha el SSE del BackendStatusService al canal de la sesión — sin
    // esto este celular recibiría solo eventos globales (ningún scan).
    this.backendStatus.conectarComoVisor(this.visorToken);

    // Formas/escalas/rubros vienen en una sola llamada token-scoped (los
    // endpoints globales ahora requieren login). Sin esto el visor no puede
    // mostrar precios.
    this.api.visorBootstrap(this.visorToken).subscribe({
      next: (b) => {
        this.escalas.set(b.escalasDescuento ?? []);
        this.precioPerfil.setDatos(b.formasPago ?? [], b.rubrosSinIva ?? []);
      },
      error: (err) => {
        if (err?.status === 404 || err?.status === 410) this.operadorInvalido.set(true);
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

    // Forma de pago elegida por el operador en el scan — el visor recalcula el
    // precio mostrado con esa forma. Sticky: se guarda hasta que llegue otra.
    this.backendStatus.visorFormaEvents$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((ev) => this.formaVisorId.set(ev.formaId));

    // Hidratación inicial del nombre del cliente (sesión activa) + SSE para
    // que el visor se actualice cuando el operador inicia/cancela sesión.
    // Usamos el endpoint token-scoped — el visor no está autenticado. El
    // error 404/410 acá significa que el token del path no corresponde a
    // una sesión activa → mostramos el overlay de "código inválido".
    this.api.visorObtenerSesion(this.visorToken).subscribe({
      next: (s) => {
        this.nombreCliente.set(s.id != null ? s.nombre : null);
        this.previousSesionId = s.id ?? null;
      },
      error: (err) => {
        if (err?.status === 404 || err?.status === 410) {
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
   *  backend pasando el token de la sesión de atención; el backend muta el
   *  carrito server-side del operador dueño de esa sesión y emite SSE
   *  `carrito-updated` en su canal personal. El response trae cuánto se
   *  sumó realmente — si fue menor a lo pedido (carrito ya al tope),
   *  mostramos warning al cliente con la cantidad real. */
  agregar(): void {
    const r = this.ultimoScan();
    if (!r || !this.puedeAgregar() || this.enviandoAgregar()) return;
    const cant = Math.max(1, Math.min(this.cantidad(), this.maxCantidad()));
    // forzar=true cuando el stock es 0/desconocido O cuando la cantidad pedida
    // supera el stock disponible: el backend acepta el ítem (o el excedente)
    // como pendiente de reposición en vez de rechazarlo.
    const forzar = r.stockTotal == null || r.stockTotal <= 0 || cant > r.stockTotal;

    this.enviandoAgregar.set(true);
    this.api.visorAgregarAlCarrito(this.visorToken, r.sku, cant, forzar).subscribe({
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
          // Mensaje pensado para el cliente: confirmamos que se agregó (tono
          // positivo) y avisamos con naturalidad que parte va por encargo, sin
          // mostrar el SKU crudo ni la palabra "sin stock" en tono de alerta.
          const nombre = r.descripcion ?? 'El producto';
          this.toast.add({
            key: 'visor',
            severity: 'info',
            summary: 'Agregado a tu pedido',
            detail: `${nombre} (x${res.cantidadAgregada}). Coordinamos la entrega de las unidades por encargo.`,
            life: 5000,
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

  /** URL token-scoped (pública) de la imagen del producto para el visor. El
   *  endpoint global `/api/showroom/productos/{sku}/imagen` que trae `imagenUrl`
   *  ahora exige login (ver SecurityConfig: "imágenes globales ya NO son
   *  públicas"); el visor no está autenticado, así que debe pedir la imagen por
   *  el endpoint gateado por token. Se construye con el mismo formato de SKU que
   *  arma el backend en {@code ImagenLocalService.urlPublica}. */
  visorImagenUrl(sku: string): string {
    return `/api/showroom/visor/t/${this.visorToken}/productos/${sku}/imagen`;
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
    return this.precioPerfil.perfilForma(forma, esMaquinaria);
  }

  /** Precio de referencia de un producto para una forma de pago dada. Siempre
   *  parte del PVP con IVA; el perfil (Normal/Maquinaria) del rubro decide el
   *  recargo y si lleva IVA. */
  precioReferenciaPorForma(
    r: { pvpKtGastroConIva: number | null; pvpKtGastroSinIva: number | null; porcIva: number | null; rubro?: string | null },
    forma: FormaPago,
  ): number {
    return this.precioPerfil.precioReferenciaPorForma(r, forma);
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

  /** Precio de REFERENCIA del producto según el rubro (forma destacada de su
   *  perfil; sin forma marcada, precio de lista por rubro). Delega en el servicio
   *  compartido — base de los escalones cuando no hay forma elegida. */
  precioReferenciaPrimario(
    r: { pvpKtGastroConIva: number | null; porcIva: number | null; pvpKtGastroSinIva: number | null; rubro?: string | null },
  ): number {
    return this.precioPerfil.precioReferencia(r);
  }


  /** true si hay un escalón con umbral mayor (y por tanto mejor) que ya
   *  aplica al precio. Lo usamos para atenuar las tarjetas de escalones
   *  "menores" cuando un cliente ya califica para uno mejor. */
  haySuperior(precio: number, escala: EscalaDescuento): boolean {
    return hayEscalonSuperior(precio, escala, this.escalasOrdenadas());
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
