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
import { RouterLink } from '@angular/router';
import { ConfirmationService, MessageService } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { DialogModule } from 'primeng/dialog';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { TextareaModule } from 'primeng/textarea';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { ToolbarModule } from 'primeng/toolbar';
import { TooltipModule } from 'primeng/tooltip';
import Papa from 'papaparse';
import QRCode from 'qrcode';
import { CatalogoItem, EtiquetaSeleccionada, PerfilEtiquetas } from '../models';
import { MoreMenu } from '../more-menu/more-menu';
import { ShowroomService } from '../showroom.service';
import { toastError } from '../toast.utils';
import { UserChip } from '../user-chip/user-chip';

interface EtiquetaImprimible {
  sku: string;
  descripcion: string | null;
  precio: number | null;
  numeroOrden: string | null;
  qrDataUrl: string;
}

/** Resolución estándar de la GC420T (y de la mayoría de las Zebra desktop). */
const ZPL_DPI = 203;
const MM_TO_DOTS = ZPL_DPI / 25.4;
const mmToDots = (mm: number) => Math.round(mm * MM_TO_DOTS);

/** Formatos soportados:
 *  - A4/A5/Letter/Legal: hojas con grilla de etiquetas; queda margen y borde de corte.
 *  - Termica: rollo continuo donde cada FILA del rollo es una página. El rollo
 *    puede traer 1 o N etiquetas por fila (configurable) con márgenes y
 *    separación interna definidos por el operador. Útil para impresoras tipo
 *    Zebra/Brother/Dymo que avanzan al siguiente label entre páginas. */
type FormatoHoja = 'A4' | 'A5' | 'Letter' | 'Legal' | 'Termica';
/** Subset de formatos que son hojas con grilla (excluye térmica). */
type FormatoSheet = Exclude<FormatoHoja, 'Termica'>;

interface DimensionHoja {
  ancho: number;
  alto: number;
  /** Valor para `@page { size: ... }`. */
  cssSize: string;
  /** Label corto para mostrar en la UI. */
  label: string;
}

const HOJAS: Record<FormatoSheet, DimensionHoja> = {
  A4:     { ancho: 210,   alto: 297,   cssSize: 'A4',     label: 'A4 (210 × 297 mm)' },
  A5:     { ancho: 148,   alto: 210,   cssSize: 'A5',     label: 'A5 (148 × 210 mm)' },
  Letter: { ancho: 215.9, alto: 279.4, cssSize: 'letter', label: 'Carta (216 × 279 mm)' },
  Legal:  { ancho: 215.9, alto: 355.6, cssSize: 'legal',  label: 'Oficio (216 × 356 mm)' },
};

/** Margen mínimo de impresión para formatos hoja (no aplica a térmica). */
const MARGEN_HOJA_MM = 5;

/** Por PC: id del perfil que esta PC tiene activo. Independiente del backend
 *  porque cada operador puede preferir un perfil distinto en su máquina. */
const STORAGE_KEY_PERFIL_ACTIVO = 'showroom.etiquetas.perfilActivoId.v1';

interface ConfigPersistida {
  formatoHoja: FormatoHoja;
  // Geometría del rollo / etiqueta
  anchoMm: number;
  altoMm: number;
  etiquetasPorFila: number;
  margenSuperiorMm: number;
  margenInferiorMm: number;
  margenIzqMm: number;
  margenDerMm: number;
  separacionMm: number;
  // Tamaños del contenido (independientes del tamaño de la etiqueta — el
  // operador los ajusta a mano para tener control total y que no varíen al
  // cambiar separación, márgenes, etc).
  qrSizeMm: number;
  fontSkuMm: number;
  fontOrdenMm: number;
  fontDescMm: number;
  fontPrecioMm: number;
  paddingEtiquetaMm: number;
  gapEtiquetaMm: number;
  textoGapMm: number;
  // Toggles
  mostrarSku: boolean;
  mostrarNumeroOrden: boolean;
  mostrarPrecio: boolean;
  mostrarDescripcion: boolean;
}

const DEFAULTS_CONFIG: ConfigPersistida = {
  formatoHoja: 'Termica',
  anchoMm: 29,
  altoMm: 19,
  etiquetasPorFila: 3,
  margenSuperiorMm: 1.5,
  margenInferiorMm: 1.5,
  margenIzqMm: 2,
  margenDerMm: 1,
  separacionMm: 3,
  // Defaults calibrados para etiqueta 29×19. Si el operador cambia el tamaño
  // del label tiene que ajustar estos a mano (pero sólo cuando los necesite).
  qrSizeMm: 14,
  fontSkuMm: 3,
  fontOrdenMm: 1.8,
  fontDescMm: 2,
  fontPrecioMm: 2.5,
  paddingEtiquetaMm: 1,
  gapEtiquetaMm: 1,
  textoGapMm: 0.5,
  mostrarSku: true,
  mostrarNumeroOrden: true,
  mostrarPrecio: false,
  mostrarDescripcion: false,
};

/** Lee el id del perfil activo de esta PC. {@code null} si no hay nada
 *  guardado todavía (primer uso) — el componente caerá al primero de la lista. */
function cargarPerfilActivoIdLocal(): number | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_PERFIL_ACTIVO);
    if (!raw) return null;
    const id = Number(raw);
    return Number.isFinite(id) ? id : null;
  } catch {
    return null;
  }
}

function guardarPerfilActivoIdLocal(id: number | null): void {
  try {
    if (id == null) localStorage.removeItem(STORAGE_KEY_PERFIL_ACTIVO);
    else localStorage.setItem(STORAGE_KEY_PERFIL_ACTIVO, String(id));
  } catch {
    // Silencioso ante fallas de localStorage (quota / modo privado).
  }
}

@Component({
  selector: 'app-etiquetas-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    FormsModule,
    RouterLink,
    ButtonModule,
    CardModule,
    DialogModule,
    InputNumberModule,
    InputTextModule,
    SelectModule,
    TableModule,
    TagModule,
    TextareaModule,
    ToggleSwitchModule,
    ToolbarModule,
    TooltipModule,
    MoreMenu,
    UserChip,
  ],
  templateUrl: './etiquetas-page.html',
  styleUrl: './etiquetas-page.scss',
})
export class EtiquetasPage {
  private readonly api = inject(ShowroomService);
  private readonly toast = inject(MessageService);
  private readonly confirmationService = inject(ConfirmationService);
  private readonly destroyRef = inject(DestroyRef);

  readonly busqueda = signal('');
  readonly resultados = signal<CatalogoItem[]>([]);
  readonly buscando = signal(false);
  readonly seleccionadas = signal<EtiquetaSeleccionada[]>([]);

  /** Estado de los perfiles de impresión — fuente de verdad: backend (compartido
   *  entre PCs). Cada perfil agrupa la config para una impresora distinta. La
   *  lista arranca vacía y se hidrata en el constructor con un GET; el
   *  perfil activo se elige por PC vía {@link STORAGE_KEY_PERFIL_ACTIVO}. */
  readonly perfiles = signal<PerfilEtiquetas[]>([]);
  readonly perfilActivoId = signal<number | null>(null);
  readonly cargandoPerfiles = signal(true);

  /** Perfil actualmente activo. Puede ser null durante la carga inicial — la
   *  UI muestra los signals con sus valores default mientras tanto. */
  readonly perfilActivo = computed<PerfilEtiquetas | null>(
    () => this.perfiles().find(p => p.id === this.perfilActivoId()) ?? this.perfiles()[0] ?? null,
  );

  /** Config inicial = valores de fábrica. Los signals la usan como valor
   *  inicial; cuando llega la carga del backend, {@code aplicarConfig} pisa
   *  los signals con la config del perfil activo. */
  private readonly configInicial: ConfigPersistida = DEFAULTS_CONFIG;

  readonly anchoMm = signal(this.configInicial.anchoMm);
  readonly altoMm = signal(this.configInicial.altoMm);
  readonly etiquetasPorFila = signal(this.configInicial.etiquetasPorFila);
  readonly margenSuperiorMm = signal(this.configInicial.margenSuperiorMm);
  readonly margenInferiorMm = signal(this.configInicial.margenInferiorMm);
  readonly margenIzqMm = signal(this.configInicial.margenIzqMm);
  readonly margenDerMm = signal(this.configInicial.margenDerMm);
  readonly separacionMm = signal(this.configInicial.separacionMm);
  readonly mostrarSku = signal(this.configInicial.mostrarSku);
  readonly mostrarNumeroOrden = signal(this.configInicial.mostrarNumeroOrden);
  readonly mostrarPrecio = signal(this.configInicial.mostrarPrecio);
  readonly mostrarDescripcion = signal(this.configInicial.mostrarDescripcion);

  /** Estado de la importación del CSV — para deshabilitar el input mientras parseamos. */
  readonly importandoCsv = signal(false);

  /** SKUs del CSV que no matchearon contra el cache — se muestran en un diálogo
   *  dedicado para que el operador pueda revisarlos y/o copiarlos. */
  readonly skusNoEncontrados = signal<string[]>([]);
  readonly mostrarDialogNoEncontrados = signal(false);

  /** Formato de hoja seleccionado — afecta tanto el cálculo de etiquetas/hoja
   *  como el `@page size` que se inyecta para imprimir. Default a "Termica"
   *  porque el cliente imprime en rollo continuo (cada fila es una página). */
  readonly formatoHoja = signal<FormatoHoja>(this.configInicial.formatoHoja);

  /** Opciones para el p-select del formato — agregamos manualmente la térmica
   *  porque no está en HOJAS (sus dimensiones dependen del Ancho/Alto). */
  readonly opcionesHoja = [
    ...(Object.keys(HOJAS) as FormatoSheet[]).map((k) => ({
      value: k as FormatoHoja,
      label: HOJAS[k].label,
    })),
    { value: 'Termica' as FormatoHoja, label: 'Impresora térmica (rollo continuo)' },
  ];

  /** True cuando la salida es a impresora térmica (cada fila = 1 página). */
  readonly esTermica = computed(() => this.formatoHoja() === 'Termica');

  /** Ancho total de una "página" térmica = margen izq + N etiquetas + (N-1) gaps + margen der. */
  readonly anchoRolloMm = computed(() => {
    const n = this.etiquetasPorFila();
    return (
      this.margenIzqMm() +
      n * this.anchoMm() +
      Math.max(0, n - 1) * this.separacionMm() +
      this.margenDerMm()
    );
  });

  /** Alto total de una "página" térmica = margen sup + alto etiqueta + margen inf. */
  readonly altoRolloMm = computed(
    () => this.margenSuperiorMm() + this.altoMm() + this.margenInferiorMm(),
  );

  // Tamaños del contenido — manuales, NO proporcionales al tamaño de la
  // etiqueta. El operador los ajusta directamente desde el panel "Tamaños del
  // contenido" para que cambiar separación, márgenes o ancho/alto del label
  // no muevan el QR ni los textos. Si la etiqueta cambia mucho de tamaño, el
  // operador re-ajusta estos valores una vez (y se persisten en localStorage).
  readonly qrSizeMm = signal(this.configInicial.qrSizeMm);
  readonly fontSkuMm = signal(this.configInicial.fontSkuMm);
  readonly fontOrdenMm = signal(this.configInicial.fontOrdenMm);
  readonly fontDescMm = signal(this.configInicial.fontDescMm);
  readonly fontPrecioMm = signal(this.configInicial.fontPrecioMm);
  readonly paddingEtiquetaMm = signal(this.configInicial.paddingEtiquetaMm);
  readonly gapEtiquetaMm = signal(this.configInicial.gapEtiquetaMm);
  readonly textoGapMm = signal(this.configInicial.textoGapMm);

  /** Posición horizontal donde arranca el bloque de texto dentro de la etiqueta. */
  readonly textoLeftMm = computed(
    () => this.paddingEtiquetaMm() + this.qrSizeMm() + this.gapEtiquetaMm(),
  );

  /** Top del QR — centrado vertical sin usar transform. (alto - qrSize)/2 */
  readonly qrTopMm = computed(() => (this.altoMm() - this.qrSizeMm()) / 2);

  /** CSS vars de tipografía y spacing del texto — se usan dentro de
   *  `.numero-orden`, `.sku`, `.descripcion`, `.precio` y `.texto`. Las
   *  dimensiones del layout (width/height/padding/gap) NO van por acá: se
   *  aplican como `[style.X.mm]` inline directo en cada elemento, porque
   *  Angular no honra el sufijo `.mm` para custom properties (solo para
   *  props estándar). Sin unidad explícita los `calc()` del SCSS fallan
   *  en print y caen al fallback. Por eso las cosas críticas para el
   *  layout van inline; acá solo lo que es puramente visual. */
  readonly cssVars = computed<Record<string, string>>(() => ({
    '--font-sku': `${this.fontSkuMm()}mm`,
    '--font-orden': `${this.fontOrdenMm()}mm`,
    '--font-desc': `${this.fontDescMm()}mm`,
    '--font-precio': `${this.fontPrecioMm()}mm`,
    '--texto-gap': `${this.textoGapMm()}mm`,
  }));

  /** Tamaño usable de la hoja actual (descontando márgenes).
   *  En modo térmica, la "hoja" es una fila del rollo — el tamaño total ya
   *  contempla los márgenes del rollo. */
  readonly hojaUsable = computed(() => {
    if (this.esTermica()) {
      return { ancho: this.anchoRolloMm(), alto: this.altoRolloMm() };
    }
    const h = HOJAS[this.formatoHoja() as FormatoSheet];
    return {
      ancho: h.ancho - MARGEN_HOJA_MM * 2,
      alto: h.alto - MARGEN_HOJA_MM * 2,
    };
  });

  /** Cuántas etiquetas entran en una hoja. En térmica = N×1 (N = etiquetasPorFila). */
  readonly distribucionHoja = computed(() => {
    if (this.esTermica()) {
      const cols = this.etiquetasPorFila();
      return { columnas: cols, filas: 1, total: cols };
    }
    const a = this.anchoMm();
    const h = this.altoMm();
    const u = this.hojaUsable();
    if (!a || a <= 0 || !h || h <= 0) {
      return { columnas: 0, filas: 0, total: 0 };
    }
    const columnas = Math.floor(u.ancho / a);
    const filas = Math.floor(u.alto / h);
    return { columnas, filas, total: columnas * filas };
  });

  /** Cantidad de páginas (en térmica = cantidad de etiquetas). */
  readonly hojasNecesarias = computed(() => {
    const porHoja = this.distribucionHoja().total;
    if (porHoja <= 0) return 0;
    const total = this.etiquetasImprimibles().length || this.totalEtiquetas();
    return Math.ceil(total / porHoja);
  });

  constructor() {
    // Inyecta un <style> dinámico en el head del documento con el `@page size`
    // del formato seleccionado. CSS `@page` es global a la impresión, no se
    // puede setear via inline style — hay que reescribir el bloque de estilos.
    const styleEl = document.createElement('style');
    styleEl.id = 'etiquetas-page-print';
    document.head.appendChild(styleEl);

    effect(() => {
      const formato = this.formatoHoja();
      if (formato === 'Termica') {
        // Cada fila del rollo es una página. El ancho total contempla márgenes
        // izq/der del rollo y las separaciones entre etiquetas; el alto incluye
        // el margen superior. `@page margin: 0` porque los márgenes los aplica
        // el wrapper `.fila-termica`.
        // NOTA: `@page` se declara a nivel top (NO dentro de `@media print`).
        // Algunos browsers (Chrome viejo, Safari) ignoran `@page` cuando está
        // anidado, lo que hace que la página real quede en su tamaño default
        // (A4) y las filas con `page-break-after` produzcan páginas A4 con
        // contenido recortado.
        const w = this.anchoRolloMm();
        const h = this.altoRolloMm();
        styleEl.textContent = `@page { size: ${w}mm ${h}mm; margin: 0; }`;
      } else {
        const cssSize = HOJAS[formato as FormatoSheet].cssSize;
        styleEl.textContent = `@page { size: ${cssSize}; margin: ${MARGEN_HOJA_MM}mm; }`;
      }
    });

    this.destroyRef.onDestroy(() => styleEl.remove());

    this.inicializarPerfiles();
  }

  /** Hidrata la lista de perfiles desde el backend. Si el backend ya tiene
   *  perfiles los carga + aplica el activo (elegido desde localStorage, o el
   *  primero). Si no hay ninguno todavía, crea un "Default" con valores de
   *  fábrica para que el operador tenga algo con qué empezar. */
  private inicializarPerfiles(): void {
    this.api.listarPerfilesEtiquetas().subscribe({
      next: (lista) => {
        if (lista.length > 0) {
          this.aplicarLista(lista);
        } else {
          this.crearPerfilInicial(DEFAULTS_CONFIG);
        }
      },
      error: (err) => {
        this.cargandoPerfiles.set(false);
        toastError(this.toast, 'Perfiles', err, 'No se pudieron cargar los perfiles de impresión');
      },
    });
  }

  private aplicarLista(lista: PerfilEtiquetas[]): void {
    this.perfiles.set(lista);
    const idLocal = cargarPerfilActivoIdLocal();
    const elegido = lista.find(p => p.id === idLocal) ?? lista[0];
    this.perfilActivoId.set(elegido.id);
    guardarPerfilActivoIdLocal(elegido.id);
    this.aplicarConfig(this.normalizarConfig(elegido.config));
    this.cargandoPerfiles.set(false);
  }

  private crearPerfilInicial(config: ConfigPersistida): void {
    this.api.crearPerfilEtiquetas({
      nombre: 'Default',
      config: config as unknown as Record<string, unknown>,
    }).subscribe({
      next: (creado) => this.aplicarLista([creado]),
      error: (err) => {
        this.cargandoPerfiles.set(false);
        toastError(this.toast, 'Perfiles', err, 'No se pudo crear el perfil inicial');
      },
    });
  }

  /** PUT del perfil activo al backend con la config actual de los signals.
   *  Disparado por el botón "Guardar perfil" del HTML — el guardado ya no es
   *  automático, el operador decide cuándo persistir sus cambios. */
  guardarPerfilActivo(): void {
    if (this.guardandoPerfil()) return;
    const idActivo = this.perfilActivoId();
    if (idActivo == null) return;
    const actual = this.perfiles().find(p => p.id === idActivo);
    if (!actual) return;
    const snap = this.snapshotConfig() as unknown as Record<string, unknown>;
    this.guardandoPerfil.set(true);
    this.api.actualizarPerfilEtiquetas(idActivo, {
      nombre: actual.nombre,
      config: snap,
    }).subscribe({
      next: (actualizado) => {
        this.guardandoPerfil.set(false);
        // Refrescamos el perfil con lo que devolvió el backend (incluye
        // `actualizadoAt`). Después de esto, `hayCambiosSinGuardar()`
        // devuelve false porque snapshot == perfil persistido.
        this.perfiles.set(this.perfiles().map(p => p.id === idActivo ? actualizado : p));
        this.toast.add({
          severity: 'success',
          summary: 'Perfil guardado',
          detail: `Se guardaron los cambios de "${actual.nombre}".`,
          life: 2500,
        });
      },
      error: (err) => {
        this.guardandoPerfil.set(false);
        toastError(this.toast, 'Perfil', err, 'No se pudo guardar el perfil');
      },
    });
  }

  /** Defensiva: mergea con DEFAULTS_CONFIG por si la config del backend tiene
   *  menos campos (config vieja sin algún campo nuevo). */
  private normalizarConfig(config: Record<string, unknown>): ConfigPersistida {
    return { ...DEFAULTS_CONFIG, ...(config as unknown as Partial<ConfigPersistida>) };
  }

  /** Snapshot de los signals de config. Centralizado para que crear/duplicar
   *  perfiles use la misma fuente de verdad que el effect de persistencia. */
  private snapshotConfig(): ConfigPersistida {
    return {
      formatoHoja: this.formatoHoja(),
      anchoMm: this.anchoMm(),
      altoMm: this.altoMm(),
      etiquetasPorFila: this.etiquetasPorFila(),
      margenSuperiorMm: this.margenSuperiorMm(),
      margenInferiorMm: this.margenInferiorMm(),
      margenIzqMm: this.margenIzqMm(),
      margenDerMm: this.margenDerMm(),
      separacionMm: this.separacionMm(),
      qrSizeMm: this.qrSizeMm(),
      fontSkuMm: this.fontSkuMm(),
      fontOrdenMm: this.fontOrdenMm(),
      fontDescMm: this.fontDescMm(),
      fontPrecioMm: this.fontPrecioMm(),
      paddingEtiquetaMm: this.paddingEtiquetaMm(),
      gapEtiquetaMm: this.gapEtiquetaMm(),
      textoGapMm: this.textoGapMm(),
      mostrarSku: this.mostrarSku(),
      mostrarNumeroOrden: this.mostrarNumeroOrden(),
      mostrarPrecio: this.mostrarPrecio(),
      mostrarDescripcion: this.mostrarDescripcion(),
    };
  }

  /** Aplica la config de un perfil a todos los signals. */
  private aplicarConfig(c: ConfigPersistida): void {
    this.formatoHoja.set(c.formatoHoja);
    this.anchoMm.set(c.anchoMm);
    this.altoMm.set(c.altoMm);
    this.etiquetasPorFila.set(c.etiquetasPorFila);
    this.margenSuperiorMm.set(c.margenSuperiorMm);
    this.margenInferiorMm.set(c.margenInferiorMm);
    this.margenIzqMm.set(c.margenIzqMm);
    this.margenDerMm.set(c.margenDerMm);
    this.separacionMm.set(c.separacionMm);
    this.qrSizeMm.set(c.qrSizeMm);
    this.fontSkuMm.set(c.fontSkuMm);
    this.fontOrdenMm.set(c.fontOrdenMm);
    this.fontDescMm.set(c.fontDescMm);
    this.fontPrecioMm.set(c.fontPrecioMm);
    this.paddingEtiquetaMm.set(c.paddingEtiquetaMm);
    this.gapEtiquetaMm.set(c.gapEtiquetaMm);
    this.textoGapMm.set(c.textoGapMm);
    this.mostrarSku.set(c.mostrarSku);
    this.mostrarNumeroOrden.set(c.mostrarNumeroOrden);
    this.mostrarPrecio.set(c.mostrarPrecio);
    this.mostrarDescripcion.set(c.mostrarDescripcion);
  }

  /** True si el snapshot actual difiere de la config persistida del perfil
   *  activo. La UI lo usa para habilitar el botón "Guardar perfil" y mostrar
   *  un asterisco al lado del nombre cuando hay cambios sin guardar. */
  readonly hayCambiosSinGuardar = computed(() => {
    const idActivo = this.perfilActivoId();
    if (idActivo == null) return false;
    const perfil = this.perfiles().find(p => p.id === idActivo);
    if (!perfil) return false;
    const snap = this.snapshotConfig() as unknown as Record<string, unknown>;
    return JSON.stringify(perfil.config) !== JSON.stringify(snap);
  });

  readonly guardandoPerfil = signal(false);

  // ===========================================================
  // CRUD de perfiles de impresión (backend)
  // ===========================================================

  cambiarPerfilActivo(id: number): void {
    const p = this.perfiles().find(x => x.id === id);
    if (!p) return;
    this.perfilActivoId.set(id);
    guardarPerfilActivoIdLocal(id);
    this.aplicarConfig(this.normalizarConfig(p.config));
    this.toast.add({
      severity: 'info',
      summary: 'Perfil activo',
      detail: `Cargada la config de "${p.nombre}".`,
      life: 2500,
    });
  }

  /** Crea un perfil nuevo con la config actual + activa el nuevo. Si el nombre
   *  choca con uno existente el backend devuelve 409 y mostramos el error. */
  crearPerfilDesdeActual(nombre: string): void {
    const limpio = nombre.trim();
    if (!limpio) return;
    this.api.crearPerfilEtiquetas({
      nombre: limpio,
      config: this.snapshotConfig() as unknown as Record<string, unknown>,
    }).subscribe({
      next: (creado) => {
        this.perfiles.set([...this.perfiles(), creado]);
        this.perfilActivoId.set(creado.id);
        guardarPerfilActivoIdLocal(creado.id);
        this.toast.add({
          severity: 'success',
          summary: 'Perfil creado',
          detail: `"${creado.nombre}" guardado y activado.`,
          life: 3000,
        });
      },
      error: (err) => toastError(this.toast, 'Crear perfil', err, 'No se pudo crear el perfil'),
    });
  }

  renombrarPerfilActivo(nombre: string): void {
    const limpio = nombre.trim();
    if (!limpio) return;
    const idActivo = this.perfilActivoId();
    if (idActivo == null) return;
    const actual = this.perfiles().find(p => p.id === idActivo);
    if (!actual || actual.nombre === limpio) return;
    this.api.actualizarPerfilEtiquetas(idActivo, {
      nombre: limpio,
      config: this.snapshotConfig() as unknown as Record<string, unknown>,
    }).subscribe({
      next: (actualizado) => {
        this.perfiles.set(this.perfiles().map(p => p.id === idActivo ? actualizado : p));
        this.toast.add({
          severity: 'success',
          summary: 'Perfil renombrado',
          detail: `Ahora se llama "${actualizado.nombre}".`,
          life: 2500,
        });
      },
      error: (err) => toastError(this.toast, 'Renombrar perfil', err, 'No se pudo renombrar el perfil'),
    });
  }

  eliminarPerfilActivo(): void {
    const perfilesActuales = this.perfiles();
    if (perfilesActuales.length <= 1) {
      this.toast.add({
        severity: 'warn',
        summary: 'No se puede eliminar',
        detail: 'Tiene que quedar al menos un perfil. Renombrá éste si querés cambiarlo.',
        life: 4000,
      });
      return;
    }
    const idActivo = this.perfilActivoId();
    if (idActivo == null) return;
    const eliminado = perfilesActuales.find(p => p.id === idActivo);
    this.api.eliminarPerfilEtiquetas(idActivo).subscribe({
      next: () => {
        const perfilesNuevos = perfilesActuales.filter(p => p.id !== idActivo);
        const nuevoActivo = perfilesNuevos[0];
        this.perfiles.set(perfilesNuevos);
        this.perfilActivoId.set(nuevoActivo.id);
        guardarPerfilActivoIdLocal(nuevoActivo.id);
        this.aplicarConfig(this.normalizarConfig(nuevoActivo.config));
        this.toast.add({
          severity: 'success',
          summary: 'Perfil eliminado',
          detail: `"${eliminado?.nombre}" eliminado. Activo ahora: "${nuevoActivo.nombre}".`,
          life: 3000,
        });
      },
      error: (err) => toastError(this.toast, 'Eliminar perfil', err, 'No se pudo eliminar el perfil'),
    });
  }

  // Dialog reutilizable para crear/renombrar perfil. Modo decide qué hace
  // {@code confirmarDialogPerfil} al aceptar.
  readonly mostrarDialogPerfil = signal(false);
  readonly modoDialogPerfil = signal<'crear' | 'renombrar'>('crear');
  readonly inputNombrePerfil = signal('');

  abrirDialogNuevoPerfil(): void {
    this.modoDialogPerfil.set('crear');
    this.inputNombrePerfil.set('');
    this.mostrarDialogPerfil.set(true);
  }

  abrirDialogRenombrarPerfil(): void {
    const actual = this.perfilActivo();
    if (!actual) return;
    this.modoDialogPerfil.set('renombrar');
    this.inputNombrePerfil.set(actual.nombre);
    this.mostrarDialogPerfil.set(true);
  }

  confirmarDialogPerfil(): void {
    const nombre = this.inputNombrePerfil().trim();
    if (!nombre) return;
    if (this.modoDialogPerfil() === 'crear') {
      this.crearPerfilDesdeActual(nombre);
    } else {
      this.renombrarPerfilActivo(nombre);
    }
    this.mostrarDialogPerfil.set(false);
  }

  confirmarEliminarPerfil(): void {
    if (this.perfiles().length <= 1) {
      this.toast.add({
        severity: 'warn',
        summary: 'No se puede eliminar',
        detail: 'Tiene que quedar al menos un perfil.',
        life: 3500,
      });
      return;
    }
    const actual = this.perfilActivo();
    if (!actual) return;
    this.confirmationService.confirm({
      header: 'Eliminar perfil',
      message: `¿Eliminar el perfil "${actual.nombre}"? Esta acción no se puede deshacer.`,
      icon: 'pi pi-exclamation-triangle',
      acceptButtonProps: { label: 'Eliminar', icon: 'pi pi-trash', severity: 'danger' },
      rejectButtonProps: { label: 'Cancelar', severity: 'secondary', outlined: true },
      accept: () => this.eliminarPerfilActivo(),
    });
  }


  private readonly qrCache = new Map<string, string>();
  readonly generandoQR = signal(false);
  readonly etiquetasImprimibles = signal<EtiquetaImprimible[]>([]);

  /** Etiquetas agrupadas en filas de N (modo térmica). Cada fila se renderiza
   *  como un wrapper `.fila-termica` que es una página completa, con padding
   *  para los márgenes del rollo y gap entre etiquetas. La última fila puede
   *  quedar incompleta — el espacio sobrante queda en blanco. */
  readonly filasTermicas = computed(() => {
    const items = this.etiquetasImprimibles();
    const n = Math.max(1, this.etiquetasPorFila());
    const filas: EtiquetaImprimible[][] = [];
    for (let i = 0; i < items.length; i += n) {
      filas.push(items.slice(i, i + n));
    }
    return filas;
  });

  readonly textoPegado = signal('');

  readonly totalEtiquetas = computed(() =>
    this.seleccionadas().reduce((acc, it) => acc + (it.copias ?? 0), 0),
  );

  readonly puedeImprimir = computed(
    () => this.totalEtiquetas() > 0 && !this.generandoQR(),
  );

  buscar(): void {
    const q = this.busqueda().trim();
    this.buscando.set(true);
    this.api.buscarCatalogo(q, 0, 100).subscribe({
      next: (page) => {
        this.buscando.set(false);
        this.resultados.set(page.items);
        if (page.items.length === 0) {
          this.toast.add({
            severity: 'info',
            summary: 'Sin resultados',
            detail: q
              ? `Nada coincide con "${q}".`
              : 'No hay productos en el catálogo. Sincronizá desde la pantalla principal.',
          });
        }
      },
      error: (err) => {
        this.buscando.set(false);
        toastError(this.toast, 'Búsqueda', err, 'No se pudo buscar');
      },
    });
  }

  /** Genera un id corto y único para cada entrada — necesario porque ahora puede
   *  haber varias entradas con el mismo SKU pero distinto número de orden. */
  private nuevoUid(): string {
    return Math.random().toString(36).slice(2, 11);
  }

  /**
   * Add manual desde el buscador o importación de SKUs sueltos: si ya hay una
   * entrada con el mismo SKU y SIN número de orden (otra entrada manual),
   * incrementamos `copias`. Las entradas con `numeroOrden` no se mergean nunca
   * (cada orden del Excel es una etiqueta distinta).
   */
  agregar(item: CatalogoItem, copias = 1): void {
    const lista = [...this.seleccionadas()];
    const idx = lista.findIndex((it) => it.sku === item.sku && !it.numeroOrden);
    if (idx >= 0) {
      lista[idx] = { ...lista[idx], copias: lista[idx].copias + copias };
    } else {
      lista.push({ ...item, copias, uid: this.nuevoUid(), numeroOrden: null });
    }
    this.seleccionadas.set(lista);
  }

  /** Add desde Excel — siempre crea una entrada nueva con número de orden,
   *  aunque ya exista otra entrada con el mismo SKU. */
  private agregarConOrden(item: CatalogoItem, numeroOrden: string, copias = 1): void {
    this.seleccionadas.set([
      ...this.seleccionadas(),
      { ...item, copias, uid: this.nuevoUid(), numeroOrden },
    ]);
  }

  cambiarCopias(uid: string, copias: number): void {
    if (copias <= 0) {
      this.quitar(uid);
      return;
    }
    this.seleccionadas.set(
      this.seleccionadas().map((it) =>
        it.uid === uid ? { ...it, copias } : it,
      ),
    );
  }

  quitar(uid: string): void {
    this.seleccionadas.set(this.seleccionadas().filter((it) => it.uid !== uid));
  }

  vaciar(): void {
    this.seleccionadas.set([]);
    this.etiquetasImprimibles.set([]);
  }

  /**
   * Importa un CSV del cliente con dos columnas: número de orden y SKU.
   * PapaParse auto-detecta el separador (`,` típico inglés / `;` típico Excel
   * en español) y maneja campos con comillas. Detecta el header por palabras
   * clave; si no matchea, asume columna A=orden y B=SKU sin saltar fila.
   * Cada fila genera una etiqueta — no se hace merge entre filas con el mismo
   * SKU porque cada orden es una etiqueta distinta.
   */
  async importarCsv(file: File): Promise<void> {
    if (!file) return;
    this.importandoCsv.set(true);

    // Si llegamos a disparar el HTTP, el subscribe se encarga de apagar el spinner.
    // Si rebotamos antes (CSV vacío, sin filas válidas o exception), lo apagamos
    // en el `finally`. Esta variable evita el doble apagado y el spinner colgado.
    let httpDisparado = false;
    try {
      const texto = await file.text();
      const parsed = Papa.parse<string[]>(texto, {
        skipEmptyLines: 'greedy',
        // header: false → devuelve arrays; auto-detecta `,` / `;` / `\t`.
      });

      const rows: string[][] = parsed.data ?? [];
      if (rows.length === 0) {
        this.toast.add({
          severity: 'warn',
          summary: 'CSV vacío',
          detail: 'El archivo no tiene filas.',
        });
        return;
      }

      // Detectar header en la primera fila por palabras clave.
      const cabecera = rows[0].map((c) => String(c ?? '').toLowerCase().trim());
      let colOrden = 0;
      let colSku = 1;
      let dataStart = 0;
      const idxOrden = cabecera.findIndex((c) => /(orden|pedido|nro|n[°º]|order)/i.test(c));
      const idxSku = cabecera.findIndex((c) => /(sku|c[oó]d|art[ií]c)/i.test(c));
      if (idxOrden >= 0 && idxSku >= 0) {
        colOrden = idxOrden;
        colSku = idxSku;
        dataStart = 1;
      } else if (idxOrden >= 0 || idxSku >= 0) {
        // Hay header pero no detectamos las dos columnas — saltamos la primera fila igual.
        dataStart = 1;
      }

      const filas: { orden: string; sku: string }[] = [];
      for (let i = dataStart; i < rows.length; i++) {
        const fila = rows[i] ?? [];
        const orden = String(fila[colOrden] ?? '').trim();
        const sku = String(fila[colSku] ?? '').trim();
        if (sku) filas.push({ orden, sku });
      }

      if (filas.length === 0) {
        this.toast.add({
          severity: 'warn',
          summary: 'CSV sin filas válidas',
          detail: 'No se encontraron SKUs. Esperaba columnas: número de orden y SKU.',
        });
        return;
      }

      // Resolvemos los SKUs únicos contra el catálogo en una sola llamada.
      const skusUnicos = [...new Set(filas.map((f) => f.sku))];
      httpDisparado = true;
      this.api.lookupBulk(skusUnicos).subscribe({
        next: (encontrados) => {
          const map = new Map(encontrados.map((it) => [it.sku, it]));
          const noEncontrados = new Set<string>();
          let agregados = 0;
          for (const { orden, sku } of filas) {
            const it = map.get(sku);
            if (it) {
              this.agregarConOrden(it, orden);
              agregados++;
            } else {
              noEncontrados.add(sku);
            }
          }
          // Toast resumen — la lista completa de los no encontrados va en el diálogo.
          this.toast.add({
            severity: agregados > 0 ? 'success' : 'warn',
            summary: 'Importar CSV',
            detail:
              `${agregados} etiqueta${agregados === 1 ? '' : 's'} agregada${agregados === 1 ? '' : 's'}.` +
              (noEncontrados.size > 0
                ? ` ${noEncontrados.size} SKU${noEncontrados.size === 1 ? '' : 's'} sin coincidencia.`
                : ''),
            life: 4000,
          });
          // Si hubo SKUs no encontrados, abrimos el diálogo con la lista completa.
          if (noEncontrados.size > 0) {
            this.skusNoEncontrados.set([...noEncontrados].sort());
            this.mostrarDialogNoEncontrados.set(true);
          } else {
            this.skusNoEncontrados.set([]);
            this.mostrarDialogNoEncontrados.set(false);
          }
          this.importandoCsv.set(false);
        },
        error: (err) => {
          this.importandoCsv.set(false);
          toastError(this.toast, 'Importar CSV', err, 'No se pudo consultar el catálogo');
        },
      });
    } catch (e) {
      const err = e as Error;
      this.toast.add({
        severity: 'error',
        summary: 'Importar CSV',
        detail: err.message ?? 'No se pudo leer el archivo',
      });
    } finally {
      // Si nunca llegamos al HTTP, apagamos el spinner acá. Si lo disparamos,
      // el subscribe ya se encargó (o lo va a hacer cuando llegue la respuesta).
      if (!httpDisparado) {
        this.importandoCsv.set(false);
      }
    }
  }

  /** Copia la lista de SKUs no encontrados al portapapeles (uno por línea),
   *  para que el operador pueda pegarla en un mail al cliente o en un ticket. */
  async copiarSkusNoEncontrados(): Promise<void> {
    const lista = this.skusNoEncontrados().join('\n');
    try {
      await navigator.clipboard.writeText(lista);
      this.toast.add({
        severity: 'success',
        summary: 'Copiado',
        detail: `${this.skusNoEncontrados().length} SKU${this.skusNoEncontrados().length === 1 ? '' : 's'} en el portapapeles.`,
        life: 2500,
      });
    } catch {
      this.toast.add({
        severity: 'error',
        summary: 'No se pudo copiar',
        detail: 'El navegador bloqueó el acceso al portapapeles.',
      });
    }
  }

  /** Handler del <input type="file"> — disparamos el parseo y reseteamos el input
   *  para que se pueda volver a importar el mismo archivo si hace falta. */
  onArchivoCsv(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) {
      this.importarCsv(file);
    }
    input.value = '';
  }

  importarPegado(): void {
    const texto = this.textoPegado().trim();
    if (!texto) return;
    const skus = texto
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (skus.length === 0) return;

    this.api.lookupBulk(skus).subscribe({
      next: (encontrados) => {
        const map = new Map(encontrados.map((it) => [it.sku, it]));
        let agregados = 0;
        const noEncontrados: string[] = [];
        for (const sku of skus) {
          const it = map.get(sku);
          if (it) {
            this.agregar(it);
            agregados++;
          } else {
            noEncontrados.push(sku);
          }
        }
        this.toast.add({
          severity: agregados > 0 ? 'success' : 'warn',
          summary: 'Importar SKUs',
          detail:
            `${agregados} agregados.` +
            (noEncontrados.length > 0
              ? ` Sin coincidencia: ${noEncontrados.slice(0, 5).join(', ')}${noEncontrados.length > 5 ? '…' : ''}`
              : ''),
        });
        this.textoPegado.set('');
      },
      error: (err) => toastError(this.toast, 'Importar', err, 'No se pudo consultar'),
    });
  }

  async preparaImpresion(): Promise<void> {
    this.generandoQR.set(true);
    try {
      const seleccionadas = this.seleccionadas();
      // Generamos QRs únicos en paralelo (cacheo + dedupe por SKU).
      const dataUrls = await Promise.all(seleccionadas.map((it) => this.obtenerQR(it.sku)));
      const expandidas: EtiquetaImprimible[] = [];
      seleccionadas.forEach((it, idx) => {
        for (let i = 0; i < it.copias; i++) {
          expandidas.push({
            sku: it.sku,
            descripcion: it.descripcion,
            precio: it.pvpKtGastroSinIva,
            numeroOrden: it.numeroOrden,
            qrDataUrl: dataUrls[idx],
          });
        }
      });
      this.etiquetasImprimibles.set(expandidas);
      // Esperamos un frame para que Angular pinte la grilla antes de window.print().
      // No mostramos un toast acá — `window.print()` no avisa si el usuario imprimió
      // o canceló, y un toast "Imprimiendo" después de un cancel queda raro. La
      // advertencia sobre el tamaño de página vive permanentemente en el info card
      // del panel (ver `esTermica()` en el template).
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      window.print();
    } catch (e) {
      const err = e as Error;
      this.toast.add({
        severity: 'error',
        summary: 'Imprimir',
        detail: err.message ?? 'No se pudo generar las etiquetas',
      });
    } finally {
      this.generandoQR.set(false);
    }
  }

  /**
   * Genera un archivo ZPL con todas las etiquetas y lo descarga. Para volúmenes
   * grandes (cientos/miles de etiquetas) o impresoras Zebra que se traban con
   * `window.print()` por buffer underrun.
   *
   * Cómo usar el archivo descargado:
   *   1. Abrir Zebra Setup Utilities (viene con el driver Zebra).
   *   2. Seleccionar la GC420T → "Open Communication With Printer".
   *   3. "File" → "Send file" → elegir el .zpl descargado.
   *
   * Diferencias con `preparaImpresion()`:
   *   - El QR lo genera la impresora con `^BQ`, no se manda como bitmap → ~30
   *     bytes por etiqueta vs ~400-700 bytes.
   *   - La impresora controla su propio ritmo, sin spooler de Windows en medio.
   *   - El cabezal calienta menos porque el firmware optimiza el barrido.
   */
  async descargarZPL(): Promise<void> {
    this.generandoQR.set(true);
    try {
      const seleccionadas = this.seleccionadas();
      // Expandir según copias — cada etiqueta es una entrada en el ZPL.
      const expandidas = seleccionadas.flatMap((it) =>
        Array.from({ length: it.copias }, () => ({
          sku: it.sku,
          descripcion: it.descripcion,
          precio: it.pvpKtGastroSinIva,
          numeroOrden: it.numeroOrden,
        })),
      );
      if (expandidas.length === 0) return;

      const zpl = this.generarZPL(expandidas);
      const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const filename = `etiquetas-${ts}.zpl`;

      const blob = new Blob([zpl], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Liberar el object URL después de que el browser termine la descarga.
      setTimeout(() => URL.revokeObjectURL(url), 1000);

      this.toast.add({
        severity: 'success',
        summary: 'ZPL generado',
        detail: `${expandidas.length} etiqueta${expandidas.length === 1 ? '' : 's'} en ${filename}. Abrilo con Zebra Setup Utilities → Send file.`,
        life: 6000,
      });
    } catch (e) {
      const err = e as Error;
      this.toast.add({
        severity: 'error',
        summary: 'Generar ZPL',
        detail: err.message ?? 'No se pudo generar el archivo',
      });
    } finally {
      this.generandoQR.set(false);
    }
  }

  /**
   * Construye el string ZPL para todas las etiquetas. Cada FILA del rollo es
   * una etiqueta lógica de ZPL (^XA...^XZ) que internamente posiciona N labels
   * con sus respectivos QR y textos. Las posiciones se calculan en dots a
   * 203 DPI (8 dots/mm).
   *
   * Setup que va al inicio (sin `^JUS`, así no persiste en EEPROM):
   *   - ^PR2,2: speed 2 ips (lento pero estable, mejor para tiradas largas
   *     con QR que calienta el cabezal).
   *   - ~SD8:   darkness 8 sobre 30 (suficiente para QR ECC L sin sobrecalentar).
   *   - ^CI28:  codepage UTF-8 (para descripciones con acentos).
   *
   * NO incluimos `^MTD` (direct thermal) porque depende del setup físico de la
   * impresora (con/sin ribbon). El operador configura el modo desde Zebra Setup
   * Utilities; nosotros respetamos esa config.
   */
  private generarZPL(
    etiquetas: { sku: string; descripcion: string | null; precio: number | null; numeroOrden: string | null }[],
  ): string {
    const cfg = {
      ancho: this.anchoMm(),
      alto: this.altoMm(),
      n: this.etiquetasPorFila(),
      sep: this.separacionMm(),
      margenIzq: this.margenIzqMm(),
      margenSup: this.margenSuperiorMm(),
      padding: this.paddingEtiquetaMm(),
      gap: this.gapEtiquetaMm(),
      qrSize: this.qrSizeMm(),
      fontSku: this.fontSkuMm(),
      fontOrden: this.fontOrdenMm(),
      fontDesc: this.fontDescMm(),
      fontPrecio: this.fontPrecioMm(),
      textoGap: this.textoGapMm(),
      anchoRollo: this.anchoRolloMm(),
      altoRollo: this.altoRolloMm(),
      mostrarSku: this.mostrarSku(),
      mostrarOrden: this.mostrarNumeroOrden(),
      mostrarDesc: this.mostrarDescripcion(),
      mostrarPrecio: this.mostrarPrecio(),
    };

    // Magnificación del QR (dots por módulo, rango ZPL 1-10). Asumimos versión 1
    // (21 módulos) — la mínima de QR. En ECC L con modo numérico cabe hasta
    // 41 dígitos, más que suficiente para los SKUs de 7 dígitos del cliente.
    // Si el cliente cambia a SKUs más largos o alfanuméricos, hay que volver
    // a un baseline más conservador (25) para que no overflow.
    const QR_MODULOS_BASELINE = 21;
    const qrMag = Math.max(
      1,
      Math.min(10, Math.floor(mmToDots(cfg.qrSize) / QR_MODULOS_BASELINE)),
    );
    // Tamaño REAL del QR (basado en magnificación discreta, no en qrSize ideal).
    // Lo usamos para centrar correctamente — sino el QR queda 1-2 mm descentrado.
    const qrSizeRealMm = (QR_MODULOS_BASELINE * qrMag) / MM_TO_DOTS;
    const anchoTextoMm = cfg.ancho - cfg.padding - cfg.qrSize - cfg.gap - cfg.padding;

    // Dividir en filas según etiquetasPorFila.
    const filas: typeof etiquetas[] = [];
    for (let i = 0; i < etiquetas.length; i += cfg.n) {
      filas.push(etiquetas.slice(i, i + cfg.n));
    }

    const out: string[] = [];

    // Setup global. Sin `^JUS` los settings duran solo hasta que la impresora
    // se reinicie; no contaminamos la EEPROM con configs específicas de este
    // trabajo (otros prints pueden necesitar speed/darkness distintos).
    out.push('^XA');
    out.push('^PR2,2');
    out.push('~SD8');
    out.push('^CI28');
    out.push('^XZ');
    out.push('');

    for (const fila of filas) {
      out.push('^XA');
      out.push(`^PW${mmToDots(cfg.anchoRollo)}`);
      out.push(`^LL${mmToDots(cfg.altoRollo)}`);
      out.push('^LH0,0');
      out.push('^LS0');

      fila.forEach((et, i) => {
        const xEt = cfg.margenIzq + i * (cfg.ancho + cfg.sep);
        const yEt = cfg.margenSup;

        // QR — centrado vertical en la etiqueta usando el tamaño REAL renderizado.
        const qrX = mmToDots(xEt + cfg.padding);
        const qrY = mmToDots(yEt + (cfg.alto - qrSizeRealMm) / 2);
        // ^BQN,2,M  — N=normal orientation, 2=model 2 (estándar), M=magnification.
        // ^FDLN,<data>  — L=ECC level low, N=numeric (10 bits cada 3 dígitos,
        // más eficiente que A=alphanumeric para SKUs solo numéricos).
        out.push(`^FO${qrX},${qrY}^BQN,2,${qrMag}^FDLN,${this.escZpl(et.sku)}^FS`);

        // Bloque de texto a la derecha del QR.
        const textoX = mmToDots(xEt + cfg.padding + cfg.qrSize + cfg.gap);

        // `lineasReales` cuenta cuánto alto consume cada línea (la descripción
        // multiline ocupa hasta 2× su font-size). Lo usamos para centrar bien.
        const lineas: {
          font: 'A0' | 'AD';
          alto: number;
          lineasReales: number;
          texto: string;
          anchoMm?: number;
        }[] = [];
        if (cfg.mostrarOrden && et.numeroOrden) {
          lineas.push({ font: 'A0', alto: cfg.fontOrden, lineasReales: 1, texto: `#${et.numeroOrden}` });
        }
        if (cfg.mostrarSku) {
          lineas.push({ font: 'AD', alto: cfg.fontSku, lineasReales: 1, texto: et.sku });
        }
        if (cfg.mostrarDesc && et.descripcion) {
          lineas.push({
            font: 'A0',
            alto: cfg.fontDesc,
            lineasReales: 2, // ^FB con max 2 líneas
            texto: et.descripcion,
            anchoMm: anchoTextoMm,
          });
        }
        if (cfg.mostrarPrecio && et.precio != null) {
          lineas.push({
            font: 'A0',
            alto: cfg.fontPrecio,
            lineasReales: 1,
            texto: `$${Math.round(et.precio).toLocaleString('es-AR')}`,
          });
        }

        // Altura total del bloque considerando que la descripción puede ocupar
        // 2 líneas. Si no la mostramos, el cálculo es trivial (1 línea c/u).
        const altoBloque =
          lineas.reduce((acc, l) => acc + l.alto * l.lineasReales, 0) +
          Math.max(0, lineas.length - 1) * cfg.textoGap;
        let yCursorMm = yEt + (cfg.alto - altoBloque) / 2;

        for (const linea of lineas) {
          const altoDots = mmToDots(linea.alto);
          const yDots = mmToDots(yCursorMm);
          // Width 0 → proporcional al alto (ZPL para fonts scalable A0/AD).
          const fontCmd = `^A${linea.font}N,${altoDots},0`;
          if (linea.anchoMm) {
            // ^FB<width>,<maxLines>,<lineSpacing>,<justify>,<hangingIndent>
            out.push(
              `^FO${textoX},${yDots}${fontCmd}^FB${mmToDots(linea.anchoMm)},${linea.lineasReales},0,L,0^FD${this.escZpl(linea.texto)}^FS`,
            );
          } else {
            out.push(`^FO${textoX},${yDots}${fontCmd}^FD${this.escZpl(linea.texto)}^FS`);
          }
          yCursorMm += linea.alto * linea.lineasReales + cfg.textoGap;
        }
      });

      out.push('^PQ1');
      out.push('^XZ');
      out.push('');
    }

    return out.join('\n');
  }

  /** Escapa caracteres especiales de ZPL (^, ~, \) en el contenido del ^FD. */
  private escZpl(s: string): string {
    return s.replace(/[\^~\\]/g, '_');
  }

  /**
   * Genera un PNG en blanco y negro puro con todas las filas del rollo apiladas
   * verticalmente y lo descarga. Pensado para impresoras térmicas tipo rotuladora
   * (Detonger, etc) cuyo manual pide imagen PNG sin fondo, B&N. El usuario abre
   * el PNG resultante con la app oficial de la impresora y lo manda a imprimir
   * sin tener que pasar antes por el diálogo de impresión del navegador ni
   * convertir a PDF.
   *
   * El canvas se renderiza a 300 DPI: suficiente para que cabezales de 200-300
   * DPI no pierdan nitidez en los QR ni en el texto pequeño.
   */
  async descargarPNG(): Promise<void> {
    this.generandoQR.set(true);
    try {
      const seleccionadas = this.seleccionadas();
      const dataUrls = await Promise.all(
        seleccionadas.map((it) => this.obtenerQR(it.sku)),
      );
      const expandidas: EtiquetaImprimible[] = [];
      seleccionadas.forEach((it, idx) => {
        for (let i = 0; i < it.copias; i++) {
          expandidas.push({
            sku: it.sku,
            descripcion: it.descripcion,
            precio: it.pvpKtGastroSinIva,
            numeroOrden: it.numeroOrden,
            qrDataUrl: dataUrls[idx],
          });
        }
      });
      if (expandidas.length === 0) return;

      const n = Math.max(1, this.etiquetasPorFila());
      const filas: EtiquetaImprimible[][] = [];
      for (let i = 0; i < expandidas.length; i += n) {
        filas.push(expandidas.slice(i, i + n));
      }

      const blob = await this.renderizarPNG(filas);

      const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const filename = `etiquetas-${ts}.png`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);

      this.toast.add({
        severity: 'success',
        summary: 'PNG generado',
        detail: `${expandidas.length} etiqueta${expandidas.length === 1 ? '' : 's'} en ${filename}. Abrilo con la app de la impresora.`,
        life: 6000,
      });
    } catch (e) {
      const err = e as Error;
      this.toast.add({
        severity: 'error',
        summary: 'Generar PNG',
        detail: err.message ?? 'No se pudo generar el archivo',
      });
    } finally {
      this.generandoQR.set(false);
    }
  }

  /**
   * Renderiza todas las filas en un único canvas (vertical) y devuelve el PNG.
   * Cada fila ocupa exactamente {@code anchoRollo × altoRollo} mm a 300 DPI.
   * Texto en negro puro, fondo blanco — sin grises porque las térmicas no
   * los manejan bien (terminan ralos o ausentes).
   */
  private async renderizarPNG(filas: EtiquetaImprimible[][]): Promise<Blob> {
    const DPI = 300;
    const PX_PER_MM = DPI / 25.4;
    const mm = (v: number) => Math.round(v * PX_PER_MM);

    const anchoRollo = this.anchoRolloMm();
    const altoRollo = this.altoRolloMm();
    const ancho = this.anchoMm();
    const alto = this.altoMm();
    const margenIzq = this.margenIzqMm();
    const margenSup = this.margenSuperiorMm();
    const sep = this.separacionMm();
    const padding = this.paddingEtiquetaMm();
    const gapQrTexto = this.gapEtiquetaMm();
    const qrSize = this.qrSizeMm();
    const textoGap = this.textoGapMm();
    const fontSku = this.fontSkuMm();
    const fontOrden = this.fontOrdenMm();
    const fontDesc = this.fontDescMm();
    const fontPrecio = this.fontPrecioMm();
    const mostrarSku = this.mostrarSku();
    const mostrarOrden = this.mostrarNumeroOrden();
    const mostrarDesc = this.mostrarDescripcion();
    const mostrarPrecio = this.mostrarPrecio();

    const W = mm(anchoRollo);
    const H = mm(altoRollo * filas.length);

    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D no disponible');

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#000000';
    ctx.textBaseline = 'top';
    // El QR ya viene rasterizado por la lib qrcode con scale 6 → cuando se
    // re-escala a tamaño físico hay que evitar el smoothing del browser para
    // que los módulos queden cuadrados nítidos en lugar de bordes grises.
    ctx.imageSmoothingEnabled = false;

    // Cargamos los QR únicos una sola vez (varias etiquetas pueden compartir SKU).
    const imgCache = new Map<string, HTMLImageElement>();
    const cargarImg = (src: string) =>
      new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('No se pudo cargar el QR'));
        img.src = src;
      });
    const srcsUnicos = new Set<string>();
    for (const fila of filas) for (const et of fila) srcsUnicos.add(et.qrDataUrl);
    await Promise.all(
      [...srcsUnicos].map(async (src) => imgCache.set(src, await cargarImg(src))),
    );

    const anchoTextoMm = ancho - padding - qrSize - gapQrTexto - padding;
    const FONT_FAMILY = "'Helvetica Neue', Arial, sans-serif";
    const FONT_FAMILY_MONO = "ui-monospace, Menlo, Consolas, monospace";

    filas.forEach((fila, filaIdx) => {
      const yFila = filaIdx * altoRollo;
      fila.forEach((et, i) => {
        const xEt = margenIzq + i * (ancho + sep);
        const yEt = yFila + margenSup;

        // QR (centrado vertical dentro de la etiqueta).
        const qrY = yEt + (alto - qrSize) / 2;
        const img = imgCache.get(et.qrDataUrl);
        if (img) {
          ctx.drawImage(
            img,
            mm(xEt + padding),
            mm(qrY),
            mm(qrSize),
            mm(qrSize),
          );
        }

        // Bloque de texto a la derecha del QR — replicamos el orden del SCSS:
        // # orden, SKU, descripción, precio. Las líneas se centran verticalmente
        // como bloque dentro del alto del label.
        const textoX = xEt + padding + qrSize + gapQrTexto;
        const lineas: {
          texto: string;
          fontMm: number;
          weight: string;
          family: string;
          lineas: number;
        }[] = [];
        if (mostrarOrden && et.numeroOrden) {
          lineas.push({
            texto: `#${et.numeroOrden}`,
            fontMm: fontOrden,
            weight: '600',
            family: FONT_FAMILY,
            lineas: 1,
          });
        }
        if (mostrarSku) {
          lineas.push({
            texto: et.sku,
            fontMm: fontSku,
            weight: '700',
            family: FONT_FAMILY_MONO,
            lineas: 1,
          });
        }
        if (mostrarDesc && et.descripcion) {
          lineas.push({
            texto: et.descripcion,
            fontMm: fontDesc,
            weight: '400',
            family: FONT_FAMILY,
            lineas: 2,
          });
        }
        if (mostrarPrecio && et.precio != null) {
          lineas.push({
            texto: `$${Math.round(et.precio).toLocaleString('es-AR')}`,
            fontMm: fontPrecio,
            weight: '600',
            family: FONT_FAMILY,
            lineas: 1,
          });
        }

        const altoBloque =
          lineas.reduce((acc, l) => acc + l.fontMm * l.lineas, 0) +
          Math.max(0, lineas.length - 1) * textoGap;
        let yCursor = yEt + (alto - altoBloque) / 2;

        for (const linea of lineas) {
          const fontPx = mm(linea.fontMm);
          ctx.font = `${linea.weight} ${fontPx}px ${linea.family}`;

          if (linea.lineas > 1) {
            // Word-wrap manual para la descripción (max 2 líneas). Si el browser
            // soporta `direction: ltr` y nuestro texto es corto, suele entrar
            // en 1 línea; cuando no, partimos por palabras respetando el ancho
            // disponible y agregamos elipsis al final si overflowea.
            const lineasRender = this.wrapTexto(
              ctx,
              linea.texto,
              mm(anchoTextoMm),
              linea.lineas,
            );
            for (const l of lineasRender) {
              ctx.fillText(l, mm(textoX), mm(yCursor));
              yCursor += linea.fontMm;
            }
            // Si la descripción ocupó menos líneas que el slot reservado, igual
            // avanzamos el cursor el slot completo para mantener el centrado
            // consistente con el cálculo de altoBloque.
            const restantes = linea.lineas - lineasRender.length;
            if (restantes > 0) yCursor += restantes * linea.fontMm;
            yCursor += textoGap;
          } else {
            ctx.fillText(linea.texto, mm(textoX), mm(yCursor));
            yCursor += linea.fontMm + textoGap;
          }
        }
      });
    });

    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('No se pudo generar el PNG'))),
        'image/png',
      );
    });
  }

  /** Word-wrap simple para multilinea (descripción). Corta por palabras hasta
   *  `maxLineas`. Si quedan palabras sin consumir, agrega elipsis en la última
   *  línea (recortando caracteres hasta que entre con el `…`). Si una sola
   *  palabra es más ancha que el espacio disponible se incluye igual — la
   *  térmica recorta. */
  private wrapTexto(
    ctx: CanvasRenderingContext2D,
    texto: string,
    anchoMaxPx: number,
    maxLineas: number,
  ): string[] {
    if (maxLineas <= 0) return [];
    const palabras = texto.split(/\s+/).filter(Boolean);
    if (palabras.length === 0) return [];

    const lineas: string[] = [];
    let actual = '';
    let consumidas = 0;

    for (let i = 0; i < palabras.length; i++) {
      const palabra = palabras[i];
      const tentativa = actual ? `${actual} ${palabra}` : palabra;
      if (ctx.measureText(tentativa).width <= anchoMaxPx) {
        actual = tentativa;
        consumidas = i + 1;
      } else {
        // No entra. Cerramos `actual` como una línea (si tiene algo) y empezamos
        // una nueva con esta palabra. Si ya alcanzamos el límite de líneas
        // permitidas, frenamos sin pushear más — `consumidas` queda en el
        // último i exitoso, así marcamos recorte.
        if (actual) {
          if (lineas.length + 1 >= maxLineas) {
            lineas.push(actual);
            actual = palabra;
            consumidas = i + 1;
            break;
          }
          lineas.push(actual);
        } else if (lineas.length >= maxLineas) {
          // Edge case: la primera palabra ya no entra y ya tenemos maxLineas.
          break;
        }
        actual = palabra;
        consumidas = i + 1;
      }
    }

    if (actual && lineas.length < maxLineas) {
      lineas.push(actual);
    } else if (actual && lineas.length === maxLineas) {
      // Quedó una palabra en `actual` que no pudimos pushear → recorte.
      // `consumidas` puede estar = palabras.length; lo bajamos para marcarlo.
      // (Ej: la última palabra del input no encontró lugar.)
      consumidas = Math.min(consumidas, palabras.length - 1);
    }

    if (consumidas < palabras.length && lineas.length > 0) {
      // Hubo recorte: meter elipsis en la última línea, achicando hasta que
      // entre con el `…` agregado. Releemos `lineas[idx]` en cada iteración
      // para evitar quedar atrapados midiendo el string original.
      const idx = lineas.length - 1;
      while (
        lineas[idx].length > 0 &&
        ctx.measureText(`${lineas[idx]}…`).width > anchoMaxPx
      ) {
        lineas[idx] = lineas[idx].slice(0, -1);
      }
      lineas[idx] = `${lineas[idx]}…`;
    }

    return lineas;
  }

  private async obtenerQR(sku: string): Promise<string> {
    const cached = this.qrCache.get(sku);
    if (cached) return cached;
    // QR para impresión térmica con configuración balanceada:
    //   - errorCorrectionLevel: 'M' (15% redundancia) — escanea bien aunque
    //     haya suciedad o rasguños.
    //   - scale: 6 — imagen 150×150 px (~1.2 KB). A 14.5 mm impresos en 203 DPI
    //     hay ~116 px físicos: downscaling de 1.3×, calidad óptima sin
    //     desperdicio. Subir más no aporta nitidez perceptible (el cabezal
    //     térmico no resuelve por debajo de 0.125 mm/punto).
    // Esto solo aplica al modo `window.print()` — el ZPL genera su propio QR
    // internamente con ^BQ y no consume este bitmap.
    const dataUrl = await QRCode.toDataURL(sku, {
      errorCorrectionLevel: 'M',
      margin: 1,
      scale: 6,
      color: { dark: '#000000', light: '#ffffff' },
    });
    this.qrCache.set(sku, dataUrl);
    return dataUrl;
  }

  trackBySku = (_: number, it: { sku: string }) => it.sku;
  trackByUid = (_: number, it: { uid: string }) => it.uid;
}
