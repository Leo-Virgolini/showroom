import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  model,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MessageService } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { CheckboxModule } from 'primeng/checkbox';
import { DialogModule } from 'primeng/dialog';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { TextareaModule } from 'primeng/textarea';
import { TooltipModule } from 'primeng/tooltip';

/** Payload emitido cuando el operador confirma el dialog. El padre decide
 *  qué hacer con esto: en /showroom dispara POST /carrito/generico y en
 *  /presupuestos crea una línea local con el SKU comodín. */
export interface ProductoGenericoData {
  descripcion: string;
  precioConIva: number;
  porcIva: number;
  cantidad: number;
  /** True si la línea representa una máquina industrial — el sistema la marca
   *  con rubro {@code MAQUINAS INDUSTRIALES} para excluirla del descuento por
   *  escala (igual que cualquier máquina del catálogo). False (default) = entra
   *  en la escala como un producto normal. */
  maquinaria: boolean;
}

/**
 * Dialog reusable para cargar a mano un "producto genérico" (sin catálogo).
 * Se usa tanto en /showroom como en /presupuestos para agregar líneas con el
 * SKU comodín de DUX cuando el operador quiere cotizar o vender un producto
 * que no está en la lista KT GASTRO.
 *
 * <p>El componente NO conoce el SKU comodín — el padre se lo pasa al backend
 * (en showroom) o lo persiste localmente (en presupuesto) ya resuelto desde
 * {@link BackendStatusService}. El dialog solo recolecta:
 * descripción, precio CON IVA, tasa de IVA (21% / 10.5%) y cantidad.
 *
 * <p>Al confirmar emite {@link agregar}. El padre cierra el dialog seteando
 * {@code visible=false} cuando la operación servidor (si aplica) termina OK.
 */
@Component({
  selector: 'app-producto-generico-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    FormsModule,
    ButtonModule,
    CheckboxModule,
    DialogModule,
    InputNumberModule,
    InputTextModule,
    SelectModule,
    TextareaModule,
    TooltipModule,
  ],
  templateUrl: './producto-generico-dialog.html',
})
export class ProductoGenericoDialog {
  private readonly toast = inject(MessageService);

  readonly visible = model<boolean>(false);
  /** True mientras el padre está procesando el {@link agregar} (POST al
   *  carrito, por ejemplo). Deshabilita el botón y muestra el spinner. */
  readonly procesando = model<boolean>(false);
  /** SKU comodín que el padre obtuvo del backend (vía {@code BackendStatusService}).
   *  Solo se muestra en el banner informativo para que el operador sepa con qué
   *  código se va a registrar la línea — el envío real al backend no necesita
   *  el SKU, lo resuelve el endpoint a partir de la config. Null/vacío oculta
   *  el dato del banner. */
  readonly sku = input<string | null>(null);
  readonly agregar = output<ProductoGenericoData>();

  readonly descripcion = signal('');
  readonly precioConIva = signal<number | null>(null);
  readonly porcIva = signal<number>(21);
  readonly cantidad = signal<number>(1);
  /** True = el producto es maquinaria industrial (no recibe descuento por
   *  escala). Default false: el caso típico de "producto que no tenemos pero
   *  podemos conseguir" es un consumible/repuesto que sí entra en la escala. */
  readonly maquinaria = signal<boolean>(false);

  /** Tasas de IVA típicas en AR — los productos KT GASTRO usan 21 (default)
   *  o 10.5 (esenciales). El operador elige según el producto que está
   *  cargando, no hay forma de inferirlo del SKU comodín. */
  readonly opcionesIva = [
    { label: '21%', value: 21 },
    { label: '10,5%', value: 10.5 },
  ];

  /** Referencia al textarea para poder enfocarlo cuando se abre el dialog.
   *  Como `pTextarea` se aplica como atributo a un `<textarea>` nativo, el
   *  template variable resuelve al ElementRef del elemento HTML directo. */
  readonly descripcionInput = viewChild<ElementRef<HTMLTextAreaElement>>('descripcionInput');

  readonly puedeAgregar = computed(() => {
    const desc = this.descripcion().trim();
    const precio = this.precioConIva() ?? 0;
    const cant = this.cantidad() ?? 0;
    return desc.length > 0 && precio > 0 && cant > 0 && !this.procesando();
  });

  constructor() {
    // Al abrir el dialog, reset de los inputs + focus en la descripción.
    // Sin el reset, si el operador cierra sin confirmar y vuelve a abrir,
    // ve los datos viejos confundiendo el flujo de "nuevo producto".
    effect(() => {
      if (this.visible()) {
        this.descripcion.set('');
        this.precioConIva.set(null);
        this.porcIva.set(21);
        this.cantidad.set(1);
        this.maquinaria.set(false);
        // Focus diferido — el dialog necesita un tick para montar el DOM.
        setTimeout(() => {
          this.descripcionInput()?.nativeElement?.focus();
        }, 100);
      }
    });
  }

  confirmar(): void {
    if (!this.puedeAgregar()) {
      this.toast.add({
        severity: 'warn',
        summary: 'Faltan datos',
        detail: 'Descripción, precio y cantidad son obligatorios.',
        life: 4000,
      });
      return;
    }
    this.agregar.emit({
      descripcion: this.descripcion().trim(),
      precioConIva: this.precioConIva() ?? 0,
      porcIva: this.porcIva(),
      cantidad: this.cantidad() ?? 1,
      maquinaria: this.maquinaria(),
    });
  }
}
