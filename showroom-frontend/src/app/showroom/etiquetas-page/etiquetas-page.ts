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
import { MessageService } from 'primeng/api';
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
import { CatalogoItem, EtiquetaSeleccionada } from '../models';
import { ShowroomService } from '../showroom.service';
import { toastError } from '../toast.utils';

interface EtiquetaImprimible {
  sku: string;
  descripcion: string | null;
  precio: number | null;
  numeroOrden: string | null;
  qrDataUrl: string;
}

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

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

/** Configuración de impresión persistida en localStorage. Versionamos la clave
 *  para poder migrar/invalidar si en el futuro cambiamos el shape del objeto
 *  (ej. agregamos un campo nuevo con un default que no debería pisarse). */
const STORAGE_KEY = 'showroom.etiquetas.config.v1';

interface ConfigPersistida {
  formatoHoja: FormatoHoja;
  anchoMm: number;
  altoMm: number;
  etiquetasPorFila: number;
  margenSuperiorMm: number;
  margenInferiorMm: number;
  margenIzqMm: number;
  margenDerMm: number;
  separacionMm: number;
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
  mostrarSku: true,
  mostrarNumeroOrden: true,
  mostrarPrecio: false,
  mostrarDescripcion: false,
};

/** Lee la config persistida; cae al default si no hay nada guardado, el JSON
 *  está corrupto o localStorage no está disponible (modo privado, etc).
 *  Mergea con DEFAULTS_CONFIG por si la versión guardada tiene menos campos
 *  (ej. veníamos de una build anterior sin `margenInferiorMm`). */
function cargarConfig(): ConfigPersistida {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS_CONFIG;
    const parsed = JSON.parse(raw) as Partial<ConfigPersistida>;
    return { ...DEFAULTS_CONFIG, ...parsed };
  } catch {
    return DEFAULTS_CONFIG;
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
  ],
  templateUrl: './etiquetas-page.html',
  styleUrl: './etiquetas-page.scss',
})
export class EtiquetasPage {
  private readonly api = inject(ShowroomService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  readonly busqueda = signal('');
  readonly resultados = signal<CatalogoItem[]>([]);
  readonly buscando = signal(false);
  readonly seleccionadas = signal<EtiquetaSeleccionada[]>([]);

  /** Config inicial leída de localStorage — los signals la usan como valor
   *  inicial y un effect del constructor sincroniza cualquier cambio de vuelta
   *  al storage. Defaults pensados para el rollo del cliente: 96×22 mm con
   *  3 etiquetas de 29×19 mm por fila, márgenes 1.5/1/2/1 y separación 3. */
  private readonly configInicial = cargarConfig();

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

  // Tipografía y spacing proporcionales al tamaño de la etiqueta. Sin esto los
  // textos quedan ridículamente chicos en labels grandes o gigantes en labels
  // chicos. Los ratios están calibrados para que la etiqueta "default" 29×19 mm
  // dé números cercanos a los originales (sku ~3mm, orden ~1.8mm, padding ~0.8mm,
  // gap ~1mm). Los clamps evitan extremos: en una etiqueta de 100mm de alto el
  // SKU no crece más de 6mm; en una de 12mm no baja de 2mm.
  readonly fontSkuMm = computed(() => clamp(this.altoMm() * 0.15, 2, 5.5));
  readonly fontOrdenMm = computed(() => clamp(this.altoMm() * 0.085, 1.3, 4));
  readonly fontDescMm = computed(() => clamp(this.altoMm() * 0.095, 1.4, 4));
  readonly fontPrecioMm = computed(() => clamp(this.altoMm() * 0.115, 1.6, 5));
  // Padding usa el menor de los dos lados — etiquetas chatas o angostas no
  // pueden tener un padding que se coma todo el espacio interno.
  readonly paddingEtiquetaMm = computed(() =>
    clamp(Math.min(this.anchoMm() * 0.04, this.altoMm() * 0.05), 0.5, 2),
  );
  readonly gapEtiquetaMm = computed(() => clamp(this.anchoMm() * 0.04, 0.5, 2));
  readonly textoGapMm = computed(() => clamp(this.altoMm() * 0.025, 0.2, 1));

  /** QR size = el menor entre el alto disponible (alto - 2*padding) y 48% del
   *  ancho. 48% deja ~12mm de texto libre en una etiqueta de 29mm — alcanza
   *  para SKUs de hasta 8 caracteres con holgura. */
  readonly qrSizeMm = computed(() =>
    Math.min(
      this.altoMm() - 2 * this.paddingEtiquetaMm(),
      this.anchoMm() * 0.48,
    ),
  );

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

    // Persistencia: cualquier cambio en los signals de config se serializa y
    // guarda en localStorage. Un único effect que lee todos los signals — más
    // eficiente que un effect por campo y garantiza atomicidad (siempre se
    // guarda un snapshot consistente, no estados intermedios).
    effect(() => {
      const config: ConfigPersistida = {
        formatoHoja: this.formatoHoja(),
        anchoMm: this.anchoMm(),
        altoMm: this.altoMm(),
        etiquetasPorFila: this.etiquetasPorFila(),
        margenSuperiorMm: this.margenSuperiorMm(),
        margenInferiorMm: this.margenInferiorMm(),
        margenIzqMm: this.margenIzqMm(),
        margenDerMm: this.margenDerMm(),
        separacionMm: this.separacionMm(),
        mostrarSku: this.mostrarSku(),
        mostrarNumeroOrden: this.mostrarNumeroOrden(),
        mostrarPrecio: this.mostrarPrecio(),
        mostrarDescripcion: this.mostrarDescripcion(),
      };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
      } catch {
        // localStorage puede fallar (quota llena, modo privado en Safari).
        // No es crítico — la sesión actual sigue funcionando con la config
        // en memoria; solo se pierde la persistencia entre recargas.
      }
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
            detail: q ? `Nada coincide con "${q}"` : 'El cache está vacío',
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

  private async obtenerQR(sku: string): Promise<string> {
    const cached = this.qrCache.get(sku);
    if (cached) return cached;
    const dataUrl = await QRCode.toDataURL(sku, {
      errorCorrectionLevel: 'M',
      margin: 1,
      scale: 8,
      color: { dark: '#000000', light: '#ffffff' },
    });
    this.qrCache.set(sku, dataUrl);
    return dataUrl;
  }

  trackBySku = (_: number, it: { sku: string }) => it.sku;
  trackByUid = (_: number, it: { uid: string }) => it.uid;
}
