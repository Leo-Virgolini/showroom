import {
  ChangeDetectionStrategy,
  Component,
  computed,
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
import { TableModule } from 'primeng/table';
import { ToolbarModule } from 'primeng/toolbar';
import { TooltipModule } from 'primeng/tooltip';
import { EscalaDescuento } from '../models';
import { ShowroomService } from '../showroom.service';
import { toastError } from '../toast.utils';

/**
 * Fila editable de la tabla. {@code umbralMin} y {@code porcentaje} pueden
 * ser null mientras el operador está completando — solo se valida al guardar.
 */
interface FilaEscala {
  umbralMin: number | null;
  porcentaje: number | null;
}

@Component({
  selector: 'app-configuracion-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    FormsModule,
    RouterLink,
    ButtonModule,
    CardModule,
    InputNumberModule,
    TableModule,
    ToolbarModule,
    TooltipModule,
  ],
  templateUrl: './configuracion-page.html',
  styleUrl: './configuracion-page.scss',
})
export class ConfiguracionPage {
  private readonly api = inject(ShowroomService);
  private readonly toast = inject(MessageService);

  readonly cargando = signal(false);
  readonly guardando = signal(false);
  readonly filas = signal<FilaEscala[]>([]);

  /** Snapshot de las filas como vinieron del backend — para el "deshacer". */
  private readonly original = signal<FilaEscala[]>([]);

  readonly hayCambios = computed(() => {
    const a = this.filas();
    const b = this.original();
    if (a.length !== b.length) return true;
    return a.some((fila, i) =>
      fila.umbralMin !== b[i].umbralMin || fila.porcentaje !== b[i].porcentaje,
    );
  });

  constructor() {
    this.cargar();
  }

  private cargar(): void {
    this.cargando.set(true);
    this.api.obtenerEscalasDescuento().subscribe({
      next: (lista) => {
        this.cargando.set(false);
        const filas = lista.map((e) => ({
          umbralMin: e.umbralMin,
          porcentaje: e.porcentaje,
        }));
        this.filas.set(filas);
        this.original.set(filas.map((f) => ({ ...f })));
      },
      error: (err) => {
        this.cargando.set(false);
        toastError(this.toast, 'Configuración', err, 'No se pudieron cargar los escalones');
      },
    });
  }

  agregarFila(): void {
    this.filas.set([...this.filas(), { umbralMin: null, porcentaje: null }]);
  }

  eliminarFila(index: number): void {
    this.filas.set(this.filas().filter((_, i) => i !== index));
  }

  actualizarUmbral(index: number, valor: number | null): void {
    this.filas.set(
      this.filas().map((f, i) => (i === index ? { ...f, umbralMin: valor } : f)),
    );
  }

  actualizarPorcentaje(index: number, valor: number | null): void {
    this.filas.set(
      this.filas().map((f, i) => (i === index ? { ...f, porcentaje: valor } : f)),
    );
  }

  descartarCambios(): void {
    this.filas.set(this.original().map((f) => ({ ...f })));
  }

  guardar(): void {
    const filas = this.filas();

    // Validación local antes de mandar — duplica la del backend pero da feedback inmediato.
    for (let i = 0; i < filas.length; i++) {
      const f = filas[i];
      if (f.umbralMin == null || f.porcentaje == null) {
        this.toast.add({
          severity: 'warn',
          summary: `Escalón #${i + 1} incompleto`,
          detail: 'Completá umbral y porcentaje, o eliminá la fila.',
          life: 4000,
        });
        return;
      }
      if (f.umbralMin <= 0) {
        this.toast.add({
          severity: 'warn',
          summary: `Escalón #${i + 1} inválido`,
          detail: 'El umbral debe ser mayor a 0.',
          life: 4000,
        });
        return;
      }
      if (f.porcentaje <= 0 || f.porcentaje >= 100) {
        this.toast.add({
          severity: 'warn',
          summary: `Escalón #${i + 1} inválido`,
          detail: 'El porcentaje debe estar entre 0 y 100.',
          life: 4000,
        });
        return;
      }
    }
    const umbrales = new Set(filas.map((f) => f.umbralMin));
    if (umbrales.size !== filas.length) {
      this.toast.add({
        severity: 'warn',
        summary: 'Umbrales duplicados',
        detail: 'No puede haber dos escalones con el mismo umbral.',
        life: 4000,
      });
      return;
    }

    const payload: EscalaDescuento[] = filas.map((f) => ({
      umbralMin: f.umbralMin!,
      porcentaje: f.porcentaje!,
    }));

    this.guardando.set(true);
    this.api.actualizarEscalasDescuento(payload).subscribe({
      next: (lista) => {
        this.guardando.set(false);
        const nuevas = lista.map((e) => ({
          umbralMin: e.umbralMin,
          porcentaje: e.porcentaje,
        }));
        this.filas.set(nuevas);
        this.original.set(nuevas.map((f) => ({ ...f })));
        this.toast.add({
          severity: 'success',
          summary: 'Configuración guardada',
          detail: `${nuevas.length} escalón${nuevas.length === 1 ? '' : 'es'} aplicado${nuevas.length === 1 ? '' : 's'}.`,
          life: 3000,
        });
      },
      error: (err) => {
        this.guardando.set(false);
        toastError(this.toast, 'Guardar', err, 'No se pudo guardar la configuración');
      },
    });
  }

  trackByIndex = (i: number) => i;
}
