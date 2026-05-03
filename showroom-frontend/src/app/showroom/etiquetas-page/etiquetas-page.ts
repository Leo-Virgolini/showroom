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
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { SelectModule } from 'primeng/select';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { TextareaModule } from 'primeng/textarea';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { ToolbarModule } from 'primeng/toolbar';
import { TooltipModule } from 'primeng/tooltip';
import QRCode from 'qrcode';
import { CatalogoItem, EtiquetaSeleccionada } from '../models';
import { ShowroomService } from '../showroom.service';
import { toastError } from '../toast.utils';

interface EtiquetaImprimible {
  sku: string;
  descripcion: string | null;
  precio: number | null;
  qrDataUrl: string;
}

/** Formatos de hoja soportados, con dimensiones en mm y el valor que va al
 *  CSS `@page size` para que la impresora aplique el tamaño correcto. */
type FormatoHoja = 'A4' | 'A5' | 'Letter' | 'Legal';

interface DimensionHoja {
  ancho: number;
  alto: number;
  /** Valor para `@page { size: ... }`. */
  cssSize: string;
  /** Label corto para mostrar en la UI. */
  label: string;
}

const HOJAS: Record<FormatoHoja, DimensionHoja> = {
  A4:     { ancho: 210,   alto: 297,   cssSize: 'A4',     label: 'A4 (210 × 297 mm)' },
  A5:     { ancho: 148,   alto: 210,   cssSize: 'A5',     label: 'A5 (148 × 210 mm)' },
  Letter: { ancho: 215.9, alto: 279.4, cssSize: 'letter', label: 'Carta (216 × 279 mm)' },
  Legal:  { ancho: 215.9, alto: 355.6, cssSize: 'legal',  label: 'Oficio (216 × 356 mm)' },
};

/** Margen mínimo de impresión (debe coincidir con el `@page margin` del SCSS). */
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
    InputNumberModule,
    InputTextModule,
    ProgressSpinnerModule,
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
  readonly mostrarPrecio = signal(true);
  readonly mostrarDescripcion = signal(true);

  /** Formato de hoja seleccionado — afecta tanto el cálculo de etiquetas/hoja
   *  como el `@page size` que se inyecta para imprimir. */
  readonly formatoHoja = signal<FormatoHoja>('A4');

  /** Opciones para el p-select del formato. */
  readonly opcionesHoja = (Object.keys(HOJAS) as FormatoHoja[]).map((k) => ({
    value: k,
    label: HOJAS[k].label,
  }));

  /** Tamaño usable de la hoja actual (descontando márgenes). */
  readonly hojaUsable = computed(() => {
    const h = HOJAS[this.formatoHoja()];
    return {
      ancho: h.ancho - MARGEN_HOJA_MM * 2,
      alto: h.alto - MARGEN_HOJA_MM * 2,
    };
  });

  /** Cuántas etiquetas entran en una hoja con el formato y tamaños actuales. */
  readonly distribucionHoja = computed(() => {
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

  /** Cantidad de hojas que se van a imprimir según la cantidad seleccionada. */
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
      const cssSize = HOJAS[this.formatoHoja()].cssSize;
      styleEl.textContent = `
        @media print {
          @page { size: ${cssSize}; margin: ${MARGEN_HOJA_MM}mm; }
        }
      `;
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

  agregar(item: CatalogoItem, copias = 1): void {
    const lista = [...this.seleccionadas()];
    const idx = lista.findIndex((it) => it.sku === item.sku);
    if (idx >= 0) {
      lista[idx] = { ...lista[idx], copias: lista[idx].copias + copias };
    } else {
      lista.push({ ...item, copias });
    }
    this.seleccionadas.set(lista);
  }

  cambiarCopias(sku: string, copias: number): void {
    if (copias <= 0) {
      this.quitar(sku);
      return;
    }
    this.seleccionadas.set(
      this.seleccionadas().map((it) =>
        it.sku === sku ? { ...it, copias } : it,
      ),
    );
  }

  quitar(sku: string): void {
    this.seleccionadas.set(this.seleccionadas().filter((it) => it.sku !== sku));
  }

  vaciar(): void {
    this.seleccionadas.set([]);
    this.etiquetasImprimibles.set([]);
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
            qrDataUrl: dataUrls[idx],
          });
        }
      });
      this.etiquetasImprimibles.set(expandidas);
      // Toast informativo del formato seleccionado — Chrome/Edge respetan el
      // `@page size` que inyectamos y lo pre-seleccionan en el dropdown del
      // diálogo de impresión, pero el operador siempre puede cambiarlo manual.
      // Recordarle qué formato eligió evita que imprima 36 etiquetas en una
      // hoja A5 cuando el browser cae a "scale to fit" porque el tamaño del
      // diálogo no coincide con el del CSS.
      this.toast.add({
        severity: 'info',
        summary: 'Imprimiendo',
        detail: `Formato ${this.formatoHoja()} · ${this.distribucionHoja().total} etiquetas/hoja. ` +
                `Verificá que en el diálogo de impresión también esté seleccionado "${this.formatoHoja()}".`,
        life: 6000,
      });
      // Esperamos un frame para que Angular pinte la grilla antes de window.print().
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
}
