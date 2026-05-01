import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  HostListener,
  ViewChild,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import { MessageService } from 'primeng/api';
import { AutoCompleteCompleteEvent, AutoCompleteModule } from 'primeng/autocomplete';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { CheckboxModule } from 'primeng/checkbox';
import { DialogModule } from 'primeng/dialog';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { InputMaskModule } from 'primeng/inputmask';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { SelectModule } from 'primeng/select';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { TextareaModule } from 'primeng/textarea';
import { ToolbarModule } from 'primeng/toolbar';
import { TooltipModule } from 'primeng/tooltip';
import { CarritoItem, Localidad, Provincia, ScanResult } from '../models';
import { ShowroomService } from '../showroom.service';
import { SyncStateService } from '../sync-state.service';
import { toastError } from '../toast.utils';

/**
 * Datos del cliente que el vendedor completa al cerrar el pedido.
 * El resto (apellidoRazonSocial, categoriaFiscal, tipoDoc) se hardcodea
 * en el envío a DUX — el CUIT es la clave que después usa la operadora
 * para autocompletar los datos reales en DUX.
 */
interface DatosCliente {
  nroDoc: number | null;
  /** Nombre y apellido (o razón social) del cliente. Se manda a DUX como
   * `apellido_razon_social`, se muestra en la carátula del PDF de presupuesto
   * y va en el nombre del archivo. Si queda vacío, se usa el fallback "PEDIDO SHOWROOM". */
  nombreCompleto: string;
  telefono: string;
  email: string;
  domicilio: string;
  codigoProvincia: string | null;
  idLocalidad: string | null;
  /** Observaciones del pedido — se persisten en `pedido_showroom.observaciones` y
   * también se envían a DUX en el campo `observaciones` del comprobante. */
  observaciones: string;
}

const CLIENTE_VACIO: DatosCliente = {
  nroDoc: null,
  nombreCompleto: '',
  telefono: '',
  email: '',
  domicilio: '',
  codigoProvincia: null,
  idLocalidad: null,
  observaciones: '',
};

/** Dominios sugeridos al tipear el email. Orden = popularidad esperada en AR. */
const DOMINIOS_EMAIL_SUGERIDOS = [
  'gmail.com',
  'hotmail.com',
  'outlook.com',
  'yahoo.com.ar',
  'live.com',
  'icloud.com',
];

/** Nombre con el que se carga todo pedido del showroom — la operadora lo
 * sobrescribe en DUX al asociar el CUIT con el cliente real. */
const APELLIDO_RAZON_SOCIAL = 'PEDIDO SHOWROOM';

/**
 * Re-ordena una lista para que los items cuyo nombre empieza con `query` aparezcan
 * antes que los que solo lo contienen. Mantiene el orden relativo dentro de cada
 * grupo. Útil para que al tipear "oliv" en el select aparezcan OLIVERA / OLIVIERA
 * antes que NICANOR OLIVERA / BOLIVAR.
 */
function ordenarPorPrefijo<T>(items: T[], query: string, getNombre: (it: T) => string): T[] {
  const q = query.toLowerCase().trim();
  if (!q) return items;
  const starts: T[] = [];
  const contains: T[] = [];
  for (const it of items) {
    const n = getNombre(it).toLowerCase();
    if (n.startsWith(q)) starts.push(it);
    else if (n.includes(q)) contains.push(it);
  }
  return [...starts, ...contains];
}

@Component({
  selector: 'app-showroom-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    FormsModule,
    RouterLink,
    AutoCompleteModule,
    ButtonModule,
    CardModule,
    CheckboxModule,
    DialogModule,
    IconFieldModule,
    InputIconModule,
    InputMaskModule,
    InputNumberModule,
    InputTextModule,
    ProgressSpinnerModule,
    SelectModule,
    TableModule,
    TagModule,
    TextareaModule,
    ToolbarModule,
    TooltipModule,
  ],
  templateUrl: './showroom-page.html',
  styleUrl: './showroom-page.scss',
})
export class ShowroomPage implements AfterViewInit {
  private readonly api = inject(ShowroomService);
  private readonly toast = inject(MessageService);
  private readonly syncState = inject(SyncStateService);
  private readonly destroyRef = inject(DestroyRef);

  @ViewChild('scanInput') scanInput?: ElementRef<HTMLInputElement>;

  readonly skuInput = signal('');
  readonly cantidadInput = signal(1);
  readonly ultimoScan = signal<ScanResult | null>(null);
  readonly cargandoScan = signal(false);
  readonly carrito = signal<CarritoItem[]>([]);
  readonly refrescando = signal(false);
  readonly enviando = signal(false);

  readonly mostrarConfirmacion = signal(false);
  readonly cliente = signal<DatosCliente>({ ...CLIENTE_VACIO });

  /** Lista de sugerencias actual del autocomplete del email — se actualiza
   *  dinámicamente con cada keystroke (ver onCompletarEmail). */
  readonly sugerenciasEmail = signal<string[]>([]);

  readonly mostrarSyncDialog = signal(false);
  readonly forzarSyncCompleto = signal(false);

  /** Estado de DUX/sync — fuente de verdad central, propagada vía SSE. */
  readonly health = this.syncState.health;

  readonly screenLg = signal(
    typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches,
  );

  readonly provincias = signal<Provincia[]>([]);
  readonly localidades = signal<Localidad[]>([]);
  readonly cargandoLocalidades = signal(false);

  /** Query actual del filtro interno de cada select — para reordenar matches. */
  readonly provinciasQuery = signal('');
  readonly localidadesQuery = signal('');

  /** Lista re-ordenada con los que empiezan por la query antes que los que solo contienen. */
  readonly provinciasOrdenadas = computed(() =>
    ordenarPorPrefijo(this.provincias(), this.provinciasQuery(), (p) => p.nombre),
  );
  readonly localidadesOrdenadas = computed(() =>
    ordenarPorPrefijo(this.localidades(), this.localidadesQuery(), (l) => l.nombre),
  );

  /** Umbrales de descuento por escala — el % se aplica al carrito completo. */
  readonly umbral5 = 399_999;
  readonly umbral10 = 899_999;

  /** Suma del PVP s/IVA por cantidad, sin aplicar descuento — base para decidir el escalón. */
  readonly subtotalPreDescuento = computed(() =>
    this.carrito().reduce(
      (acc, it) => acc + (it.pvpKtGastroSinIva ?? 0) * it.cantidad,
      0,
    ),
  );

  /** Descuento % derivado del subtotal — 0/5/10 según los umbrales. */
  readonly descuentoAplicado = computed(() => {
    const sub = this.subtotalPreDescuento();
    if (sub >= this.umbral10) return 10;
    if (sub >= this.umbral5) return 5;
    return 0;
  });

  /** Monto del descuento (en pesos) sobre el subtotal pre-descuento. */
  readonly descuentoMonto = computed(
    () => (this.subtotalPreDescuento() * this.descuentoAplicado()) / 100,
  );

  readonly totalCarrito = computed(
    () => this.subtotalPreDescuento() - this.descuentoMonto(),
  );

  readonly cantidadTotal = computed(() =>
    this.carrito().reduce((acc, it) => acc + it.cantidad, 0),
  );

  /** Precio unitario efectivo aplicando el descuento global vigente. */
  precioEfectivo(it: CarritoItem): number {
    const base = it.pvpKtGastroSinIva ?? 0;
    return base * (1 - this.descuentoAplicado() / 100);
  }

  /** Subtotal de la línea SIN descuento — el descuento se muestra solo a nivel total. */
  subtotal(it: CarritoItem): number {
    return (it.pvpKtGastroSinIva ?? 0) * it.cantidad;
  }

  /** Pesos que faltan para llegar al próximo escalón — null si ya está en -10%. */
  readonly faltaParaProximo = computed(() => {
    const sub = this.subtotalPreDescuento();
    if (sub >= this.umbral10) return null;
    if (sub >= this.umbral5) return this.umbral10 - sub;
    return this.umbral5 - sub;
  });

  /** Próximo escalón al que se llegaría — 5 o 10, null si ya está en -10%. */
  readonly proximoEscalon = computed(() => {
    const sub = this.subtotalPreDescuento();
    if (sub >= this.umbral10) return null;
    if (sub >= this.umbral5) return 10;
    return 5;
  });

  stockSeverity(stock: number | null): 'success' | 'danger' | 'secondary' {
    if (stock == null) return 'secondary';
    return stock > 0 ? 'success' : 'danger';
  }

  ahorro(base: number | null, descuento: number): number {
    if (base == null) return 0;
    return base * (descuento / 100);
  }

  /** Si la URL de la imagen falla al cargar, blanqueamos el campo para que aparezca el placeholder. */
  onImagenError(_e: Event): void {
    const r = this.ultimoScan();
    if (r?.imagenUrl) this.ultimoScan.set({ ...r, imagenUrl: null });
  }

  /** Formato relativo "hace X min/hora/día" para fechas recientes. */
  tiempoRelativo(iso: string | null | undefined): string {
    if (!iso) return '—';
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 60_000) return 'hace unos segundos';
    const min = Math.floor(ms / 60_000);
    if (min < 60) return `hace ${min} min`;
    const hs = Math.floor(min / 60);
    if (hs < 24) return `hace ${hs} h`;
    const d = Math.floor(hs / 24);
    return `hace ${d} día${d === 1 ? '' : 's'}`;
  }

  /** Tope de cantidad para el InputNumber: stock conocido o 999 si DUX no informó. */
  maxCantidad(stock: number | null | undefined): number {
    return stock != null && stock > 0 ? stock : 999;
  }

  excedeStock(it: CarritoItem): boolean {
    return it.stockTotal != null && it.stockTotal >= 0 && it.cantidad > it.stockTotal;
  }

  readonly hayItemsExcedidos = computed(() => this.carrito().some((it) => this.excedeStock(it)));

  readonly puedeEnviar = computed(() => {
    const c = this.cliente();
    return (
      c.nroDoc != null &&
      this.cuitValido(c.nroDoc) &&
      !!c.codigoProvincia &&
      this.carrito().length > 0 &&
      !this.hayItemsExcedidos()
    );
  });

  /** CUIT/CUIL = 11 dígitos. No validamos el dígito verificador para no rebotar
   * a la operadora si DUX lo acepta igual. */
  cuitValido(n: number | null | undefined): boolean {
    if (n == null) return false;
    const s = String(n);
    return s.length === 11;
  }

  /** Valor (string) que ve el inputMask: el nroDoc del cliente como dígitos puros
   *  para que la máscara `99-99999999-9` lo formatee con guiones automáticamente. */
  readonly cuitInputValue = computed(() => {
    const n = this.cliente().nroDoc;
    return n != null ? String(n) : '';
  });

  /** Recibe el valor del inputMask con [unmask]="true" — solo dígitos. Lo convertimos
   *  a number para que el resto del flujo (validación, payload a DUX) siga igual. */
  onCuitChange(value: string | null | undefined): void {
    const digits = (value ?? '').replace(/\D/g, '');
    this.actualizarCliente('nroDoc', digits ? Number(digits) : null);
  }

  constructor() {
    if (typeof window === 'undefined') return;

    const mq = window.matchMedia('(min-width: 1024px)');
    const sync = (e: MediaQueryListEvent | MediaQueryList) => this.screenLg.set(e.matches);
    mq.addEventListener('change', sync as (e: MediaQueryListEvent) => void);
    this.destroyRef.onDestroy(() =>
      mq.removeEventListener('change', sync as (e: MediaQueryListEvent) => void),
    );

    // En dispositivos táctiles (tablets/phones) reenfocar al click abre el
    // teclado virtual cada vez que tocan algo. Solo activamos el auto-refocus
    // si hay puntero fino (mouse + pistola HID conectada por USB).
    const isCoarse = window.matchMedia('(pointer: coarse)').matches;
    if (isCoarse) return;

    const refocus = (e: MouseEvent) => {
      if (this.mostrarConfirmacion()) return;
      const target = e.target as HTMLElement | null;
      if (
        target?.closest(
          'input, textarea, select, button, [role="button"], a, label, ' +
            '.p-inputnumber, .p-select, .p-selectbutton, .p-toggleswitch, ' +
            '.p-dialog, .p-tooltip',
        )
      ) {
        return;
      }
      this.focusInput();
    };
    document.addEventListener('click', refocus);
    this.destroyRef.onDestroy(() => document.removeEventListener('click', refocus));
  }

  ngAfterViewInit(): void {
    // En desktop enfocamos automáticamente para que la pistola QR funcione sin click.
    // En táctil, NO — el teclado virtual saltaría al cargar la página.
    if (typeof window === 'undefined' || !window.matchMedia('(pointer: coarse)').matches) {
      this.focusInput();
    }
  }

  @HostListener('document:keydown', ['$event'])
  onKeyDown(e: KeyboardEvent): void {
    if (e.key === '/' && !this.mostrarConfirmacion()) {
      const target = e.target as HTMLElement;
      if (target?.tagName !== 'INPUT' && target?.tagName !== 'TEXTAREA') {
        e.preventDefault();
        this.focusInput();
      }
    }
  }

  private focusInput(): void {
    queueMicrotask(() => this.scanInput?.nativeElement.focus());
  }

  confirmarSincronizar(): void {
    if (this.health()?.syncEnCurso) {
      this.toast.add({
        severity: 'info',
        summary: 'Sincronización en curso',
        detail: 'Ya hay un sync corriendo en background.',
      });
      return;
    }
    this.forzarSyncCompleto.set(false);
    this.mostrarSyncDialog.set(true);
  }

  ejecutarSync(): void {
    const force = this.forzarSyncCompleto();
    this.mostrarSyncDialog.set(false);
    this.api.syncCatalogo(force).subscribe({
      next: () => {
        this.toast.add({
          severity: 'info',
          summary: force ? 'Sync completo iniciado' : 'Sincronización iniciada',
          detail: force
            ? 'Descarga todo el catálogo (~12 min). El banner global muestra el progreso.'
            : 'Va a correr en background. El banner global muestra el progreso.',
          life: 5000,
        });
        this.syncState.refrescarHealth();
      },
      error: (err) => toastError(this.toast, 'Sync', err, 'No se pudo iniciar el sync'),
    });
  }

  onSubmitScan(): void {
    const sku = this.skuInput().trim();
    if (!sku) return;
    this.skuInput.set('');
    this.cargandoScan.set(true);

    this.api.scan(sku).subscribe({
      next: (r) => {
        this.cargandoScan.set(false);
        this.ultimoScan.set(r);
        this.cantidadInput.set(1);
        this.focusInput();
        if (r.habilitado === false) {
          this.toast.add({
            severity: 'warn',
            summary: 'Producto deshabilitado',
            detail: r.sku,
          });
        }
      },
      error: (err) => {
        this.cargandoScan.set(false);
        this.ultimoScan.set(null);
        this.focusInput();
        toastError(this.toast, 'Scan', err, 'Error al consultar SKU');
      },
    });
  }

  agregarAlCarrito(cantidad: number = 1): void {
    const r = this.ultimoScan();
    if (!r) return;
    if (cantidad <= 0) cantidad = 1;

    const lista = [...this.carrito()];
    const idx = lista.findIndex((it) => it.sku === r.sku);
    const cantidadActual = idx >= 0 ? lista[idx].cantidad : 0;
    const cantidadDeseada = cantidadActual + cantidad;
    const stock = r.stockTotal;
    const cantidadFinal = stock != null && stock >= 0 ? Math.min(cantidadDeseada, stock) : cantidadDeseada;
    const recortado = cantidadFinal < cantidadDeseada;

    if (cantidadFinal <= 0) {
      this.toast.add({
        severity: 'warn',
        summary: 'Sin stock',
        detail: `${r.sku} no tiene unidades disponibles.`,
      });
      return;
    }

    if (idx >= 0) {
      lista[idx] = { ...lista[idx], cantidad: cantidadFinal };
    } else {
      lista.push({ ...r, cantidad: cantidadFinal });
    }
    this.carrito.set(lista);

    this.toast.add({
      severity: recortado ? 'warn' : 'success',
      summary: recortado ? 'Cantidad ajustada al stock' : 'Agregado',
      detail: recortado
        ? `${r.sku}: tope ${stock} unidades disponibles.`
        : `${r.sku} x${cantidad}`,
      life: recortado ? 3500 : 1500,
    });
    this.focusInput();
  }

  actualizarCantidad(sku: string, cantidad: number): void {
    // Mínimo 1 — para eliminar el item está la X dedicada al lado.
    const c = Math.max(1, cantidad ?? 1);
    this.carrito.set(
      this.carrito().map((it) => {
        if (it.sku !== sku) return it;
        const stock = it.stockTotal;
        if (stock != null && stock >= 0 && c > stock) {
          this.toast.add({
            severity: 'warn',
            summary: 'Cantidad ajustada al stock',
            detail: `${it.sku}: tope ${stock} unidades.`,
            life: 3500,
          });
          return { ...it, cantidad: stock };
        }
        return { ...it, cantidad: c };
      }),
    );
  }

  eliminarDelCarrito(sku: string): void {
    this.carrito.set(this.carrito().filter((it) => it.sku !== sku));
  }

  vaciarCarrito(): void {
    this.carrito.set([]);
    this.ultimoScan.set(null);
    this.focusInput();
  }

  refrescarStockCarrito(): void {
    const skus = this.carrito().map((it) => it.sku);
    if (skus.length === 0) return;
    this.refrescando.set(true);
    this.api.refreshStock(skus).subscribe({
      next: (resultados) => {
        this.refrescando.set(false);
        const map = new Map(resultados.map((r) => [r.sku, r]));
        const excedidos: string[] = [];
        this.carrito.set(
          this.carrito().map((it) => {
            const fresh = map.get(it.sku);
            if (!fresh) return it;
            const stock = fresh.stockTotal;
            const cantidad = it.cantidad;
            if (stock != null && stock >= 0 && cantidad > stock) {
              excedidos.push(`${it.sku} (${cantidad}→${stock})`);
            }
            return { ...fresh, cantidad };
          }),
        );
        if (excedidos.length > 0) {
          this.toast.add({
            severity: 'warn',
            summary: 'Items con stock insuficiente',
            detail: `Ajustar: ${excedidos.join(', ')}`,
            life: 8000,
          });
        } else {
          this.toast.add({
            severity: 'success',
            summary: 'Stock actualizado',
            detail: `${resultados.length} items refrescados desde DUX`,
          });
        }
      },
      error: (err) => {
        this.refrescando.set(false);
        toastError(this.toast, 'Refrescar', err, 'No se pudo refrescar stock');
      },
    });
  }

  abrirConfirmacion(): void {
    if (this.carrito().length === 0) return;
    this.mostrarConfirmacion.set(true);
    this.cargarProvinciasSiHaceFalta();
  }

  actualizarCliente<K extends keyof DatosCliente>(campo: K, valor: DatosCliente[K]): void {
    this.cliente.set({ ...this.cliente(), [campo]: valor });
  }

  /**
   * Genera sugerencias para el autocomplete del email basadas en lo que tipeó el operador:
   *  - Sin `@` todavía: sugerir `<lo-que-escribió>@<dominio>` para los dominios populares.
   *  - Con `@` ya escrito: filtrar la lista de dominios por los que matchean lo que sigue.
   *  - Si ya hay un dominio completo válido (otro `.` después del `@`), no sugerir nada
   *    (no pisar la elección manual del operador).
   */
  onCompletarEmail(event: AutoCompleteCompleteEvent): void {
    const query = (event.query ?? '').trim();
    if (!query) {
      this.sugerenciasEmail.set([]);
      return;
    }
    const at = query.indexOf('@');
    if (at < 0) {
      // No tiene @ — sugerir todos los dominios.
      this.sugerenciasEmail.set(DOMINIOS_EMAIL_SUGERIDOS.map((d) => `${query}@${d}`));
      return;
    }
    const localPart = query.substring(0, at);
    const dominioPart = query.substring(at + 1).toLowerCase();
    if (!localPart) {
      this.sugerenciasEmail.set([]);
      return;
    }
    // Si ya hay un dominio "completo" (algo.algo), no sugerimos.
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

  /**
   * Carga la lista de provincias la primera vez que se abre el dialog.
   * El backend ya cachea, así que llamadas subsiguientes son baratas — pero
   * igual evitamos una HTTP innecesaria cuando ya está en memoria del frontend.
   */
  private cargarProvinciasSiHaceFalta(): void {
    if (this.provincias().length > 0) {
      this.aplicarProvinciaDefault();
      return;
    }
    this.api.obtenerProvincias().subscribe({
      next: (lista) => {
        this.provincias.set(lista);
        this.aplicarProvinciaDefault();
      },
      error: (err) =>
        toastError(this.toast, 'Provincias', err, 'No se pudieron cargar las provincias'),
    });
  }

  /** Selecciona "BUENOS AIRES" si todavía no hay provincia elegida. */
  private aplicarProvinciaDefault(): void {
    if (this.cliente().codigoProvincia) return;
    const ba = this.provincias().find((p) =>
      p.nombre.trim().toUpperCase() === 'BUENOS AIRES',
    );
    if (ba) this.cambiarProvincia(ba.codigo);
  }

  /** Subscription a la request en curso de localidades — para poder cancelarla. */
  private localidadesSub: Subscription | null = null;

  cambiarProvincia(codigo: string | null): void {
    // Si ya había una request en curso (otra provincia), abortarla.
    this.localidadesSub?.unsubscribe();
    this.localidadesSub = null;

    this.cliente.set({
      ...this.cliente(),
      codigoProvincia: codigo,
      idLocalidad: null,
    });
    this.localidades.set([]);
    if (!codigo) {
      this.cargandoLocalidades.set(false);
      return;
    }
    this.cargandoLocalidades.set(true);
    this.localidadesSub = this.api.obtenerLocalidades(codigo).subscribe({
      next: (lista) => {
        this.cargandoLocalidades.set(false);
        this.localidades.set(lista);
        this.localidadesSub = null;
      },
      error: (err) => {
        this.cargandoLocalidades.set(false);
        this.localidadesSub = null;
        toastError(this.toast, 'Localidades', err, 'No se pudieron cargar las localidades');
      },
    });
  }

  onFilterProvincias(event: { filter: string }): void {
    this.provinciasQuery.set(event.filter || '');
  }

  onFilterLocalidades(event: { filter: string }): void {
    this.localidadesQuery.set(event.filter || '');
  }

  /**
   * Cancela la búsqueda de localidades en curso y limpia la provincia para que
   * el operador pueda elegir otra. La descarga sigue en el backend (donde se
   * guarda en BD, así que no es trabajo perdido), pero la UI ya no espera.
   */
  cancelarBusquedaLocalidades(): void {
    this.localidadesSub?.unsubscribe();
    this.localidadesSub = null;
    this.cargandoLocalidades.set(false);
    this.localidades.set([]);
    this.cliente.set({
      ...this.cliente(),
      codigoProvincia: null,
      idLocalidad: null,
    });
  }

  confirmarEnvio(): void {
    if (this.hayItemsExcedidos()) {
      this.toast.add({
        severity: 'warn',
        summary: 'Hay items que superan el stock',
        detail: 'Ajustá las cantidades antes de enviar a DUX.',
      });
      return;
    }
    if (!this.puedeEnviar()) {
      this.toast.add({
        severity: 'warn',
        summary: 'Faltan datos',
        detail: 'CUIT (11 dígitos) y provincia son requeridos.',
      });
      return;
    }
    const c = this.cliente();
    this.enviando.set(true);

    this.api
      .crearPedido({
        // Si el operador completa "Nombre y apellido", lo mandamos como razón social
        // (queda en DUX y en el PDF/XLSX). Si lo deja vacío, fallback al placeholder
        // que la operadora puede asociar con el cliente real después.
        apellidoRazonSocial: c.nombreCompleto.trim() || APELLIDO_RAZON_SOCIAL,
        categoriaFiscal: 'CONSUMIDOR_FINAL',
        tipoDoc: 'CUIT',
        nroDoc: c.nroDoc ?? undefined,
        telefono: c.telefono.trim() || undefined,
        email: c.email.trim() || undefined,
        domicilio: c.domicilio.trim() || undefined,
        codigoProvincia: c.codigoProvincia ?? undefined,
        idLocalidad: c.idLocalidad ?? undefined,
        observaciones: c.observaciones.trim() || undefined,
        items: this.carrito().map((it) => ({
          sku: it.sku,
          cantidad: it.cantidad,
          // Mandamos el precio CON IVA: la lista "KT GASTRO" en DUX está configurada
          // como "incluye IVA", entonces DUX espera valores con-IVA y descuenta el IVA
          // internamente. Si mandamos sin-IVA, DUX lo trata como con-IVA y queda mal.
          // El display en el showroom sigue mostrando sin-IVA al operador (informativo).
          precioUnitario: it.pvpKtGastroConIva,
          descuentoPorcentaje: this.descuentoAplicado() || undefined,
        })),
      })
      .subscribe({
        next: (res) => {
          this.enviando.set(false);
          this.mostrarConfirmacion.set(false);
          if (res.estado === 'ENVIADO') {
            this.toast.add({
              severity: 'success',
              summary: 'Pedido cargado en DUX',
              detail: res.mensaje,
              life: 5000,
            });
            this.vaciarCarrito();
            this.cliente.set({ ...CLIENTE_VACIO });
          } else {
            this.toast.add({
              severity: 'warn',
              summary: 'Pedido pendiente',
              detail: res.mensaje,
              life: 8000,
            });
          }
        },
        error: (err) => {
          this.enviando.set(false);
          toastError(this.toast, 'Pedido', err, 'Error al enviar pedido');
        },
      });
  }

  trackBySku = (_: number, it: CarritoItem) => it.sku;
}
