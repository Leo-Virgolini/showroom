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
 *  - Termica: una etiqueta por página, página = tamaño de la etiqueta, sin márgenes.
 *    Útil para impresoras térmicas tipo Zebra/Brother/Dymo que tienen un rollo
 *    continuo y avanzan al siguiente label entre páginas. */
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

  readonly anchoMm = signal(50);
  readonly altoMm = signal(30);
  readonly mostrarSku = signal(true);
  readonly mostrarNumeroOrden = signal(true);
  readonly mostrarPrecio = signal(false);
  readonly mostrarDescripcion = signal(false);

  /** Estado de la importación del CSV — para deshabilitar el input mientras parseamos. */
  readonly importandoCsv = signal(false);

  /** SKUs del CSV que no matchearon contra el cache — se muestran en un diálogo
   *  dedicado para que el operador pueda revisarlos y/o copiarlos. */
  readonly skusNoEncontrados = signal<string[]>([]);
  readonly mostrarDialogNoEncontrados = signal(false);

  /** Formato de hoja seleccionado — afecta tanto el cálculo de etiquetas/hoja
   *  como el `@page size` que se inyecta para imprimir. Default a "Termica"
   *  porque el cliente imprime en impresora térmica (1 etiqueta por página). */
  readonly formatoHoja = signal<FormatoHoja>('Termica');

  /** Opciones para el p-select del formato — agregamos manualmente la térmica
   *  porque no está en HOJAS (sus dimensiones dependen del Ancho/Alto). */
  readonly opcionesHoja = [
    ...(Object.keys(HOJAS) as FormatoSheet[]).map((k) => ({
      value: k as FormatoHoja,
      label: HOJAS[k].label,
    })),
    { value: 'Termica' as FormatoHoja, label: 'Impresora térmica (1 etiqueta/página)' },
  ];

  /** True cuando la salida es a impresora térmica (cada label = 1 página). */
  readonly esTermica = computed(() => this.formatoHoja() === 'Termica');

  /** Tamaño usable de la hoja actual (descontando márgenes).
   *  En modo térmica, la "hoja" es la etiqueta misma — sin márgenes. */
  readonly hojaUsable = computed(() => {
    if (this.esTermica()) {
      return { ancho: this.anchoMm(), alto: this.altoMm() };
    }
    const h = HOJAS[this.formatoHoja() as FormatoSheet];
    return {
      ancho: h.ancho - MARGEN_HOJA_MM * 2,
      alto: h.alto - MARGEN_HOJA_MM * 2,
    };
  });

  /** Cuántas etiquetas entran en una hoja. En térmica siempre 1×1. */
  readonly distribucionHoja = computed(() => {
    if (this.esTermica()) {
      return { columnas: 1, filas: 1, total: 1 };
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
        // Cada etiqueta es su propia página; la página = tamaño de la etiqueta.
        // Sin márgenes (la impresora térmica avanza por feed, no por hoja).
        const w = this.anchoMm();
        const h = this.altoMm();
        styleEl.textContent = `
          @media print {
            @page { size: ${w}mm ${h}mm; margin: 0; }
          }
        `;
      } else {
        const cssSize = HOJAS[formato as FormatoSheet].cssSize;
        styleEl.textContent = `
          @media print {
            @page { size: ${cssSize}; margin: ${MARGEN_HOJA_MM}mm; }
          }
        `;
      }
    });

    this.destroyRef.onDestroy(() => styleEl.remove());
  }

  private readonly qrCache = new Map<string, string>();
  readonly generandoQR = signal(false);
  readonly etiquetasImprimibles = signal<EtiquetaImprimible[]>([]);

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
