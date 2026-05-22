import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink, Router } from '@angular/router';
import { MenuItem, MessageService } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { InputTextModule } from 'primeng/inputtext';
import { SplitButtonModule } from 'primeng/splitbutton';
import { TableModule } from 'primeng/table';
import { ToolbarModule } from 'primeng/toolbar';
import { TooltipModule } from 'primeng/tooltip';
import { ClientePresupuestos } from '../models';
import { MoreMenu } from '../more-menu/more-menu';
import { ShowroomService } from '../showroom.service';
import { toastError } from '../toast.utils';
import { UserChip } from '../user-chip/user-chip';

/**
 * Lista de clientes únicos derivada de presupuestos comerciales + pedidos.
 * Agrupa por teléfono normalizado (solo dígitos): movimientos sin teléfono
 * no aparecen acá. Los datos canónicos (nombre, email, rubro) se toman del
 * movimiento más reciente del cliente sin importar si fue presupuesto o
 * pedido.
 *
 * <p>Sirve al operador como agenda informal: ver de un vistazo a quién le
 * cotizó/vendió y abrir el historial o listado de pedidos filtrado por ese
 * cliente. El botón "Ver" expone un split-button con dos acciones según
 * los contadores: "Ver presupuestos" y "Ver pedidos" (deshabilitadas si la
 * cantidad es 0).
 */
@Component({
  selector: 'app-presupuestos-clientes-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    FormsModule,
    RouterLink,
    ButtonModule,
    CardModule,
    IconFieldModule,
    InputIconModule,
    InputTextModule,
    SplitButtonModule,
    TableModule,
    ToolbarModule,
    TooltipModule,
    MoreMenu,
    UserChip,
  ],
  templateUrl: './presupuestos-clientes-page.html',
})
export class PresupuestosClientesPage {
  private readonly api = inject(ShowroomService);
  private readonly toast = inject(MessageService);
  private readonly router = inject(Router);

  readonly screenLg = signal(
    typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches,
  );

  readonly cargando = signal(false);
  readonly clientes = signal<ClientePresupuestos[]>([]);
  readonly busqueda = signal('');

  /** Filtro client-side: substring case-insensitive sobre nombre/email/
   *  teléfono. Como el endpoint devuelve todos los clientes sin paginar,
   *  filtrar en memoria es instantáneo. */
  readonly clientesFiltrados = computed(() => {
    const q = this.busqueda().trim().toLowerCase();
    if (!q) return this.clientes();
    return this.clientes().filter((c) =>
      (c.nombre ?? '').toLowerCase().includes(q) ||
      (c.email ?? '').toLowerCase().includes(q) ||
      (c.telefono ?? '').toLowerCase().includes(q),
    );
  });

  constructor() {
    this.cargar();
  }

  private cargar(): void {
    this.cargando.set(true);
    this.api.listarClientesPresupuestos().subscribe({
      next: (lista) => {
        this.cargando.set(false);
        this.clientes.set(lista);
      },
      error: (err) => {
        this.cargando.set(false);
        toastError(this.toast, 'Clientes', err,
          'No se pudieron cargar los clientes.');
      },
    });
  }

  refrescar(): void {
    this.cargar();
  }

  /** Calcula un fragmento del teléfono útil como query LIKE en backend —
   *  los últimos 8 dígitos del teléfono normalizado. Funciona aunque el
   *  operador haya tipeado formatos distintos del mismo número en cada
   *  movimiento (con o sin guiones, etc.). */
  private fragmentoTelefono(c: ClientePresupuestos): string {
    if (!c.telefono) return '';
    const soloDigitos = c.telefono.replace(/\D+/g, '');
    return soloDigitos.slice(-8) || soloDigitos;
  }

  /** Abre el historial de presupuestos filtrado por el teléfono del cliente. */
  verPresupuestos(c: ClientePresupuestos): void {
    const fragmento = this.fragmentoTelefono(c);
    this.router.navigate(['/presupuestos/historial'], {
      queryParams: fragmento ? { q: fragmento } : {},
    });
  }

  /** Abre el listado de pedidos filtrado por el teléfono del cliente. */
  verPedidos(c: ClientePresupuestos): void {
    const fragmento = this.fragmentoTelefono(c);
    this.router.navigate(['/pedidos'], {
      queryParams: fragmento ? { q: fragmento } : {},
    });
  }

  /** Items del menú split-button "Ver" por fila. Usamos {@code routerLink} +
   *  {@code queryParams} directamente en cada item (NO {@code command}: con
   *  {@code appendTo="body"} y change-detection OnPush los callbacks de
   *  command no se disparan de forma confiable en PrimeNG SplitButton). El
   *  patrón {@code routerLink} sí funciona porque PrimeNG lo bindea al
   *  RouterLink directive de Angular y la navegación va por el router. */
  itemsVer(c: ClientePresupuestos): MenuItem[] {
    const fragmento = this.fragmentoTelefono(c);
    const queryParams = fragmento ? { q: fragmento } : {};
    return [
      {
        label: `Ver presupuestos${c.cantidadPresupuestos > 0 ? ' (' + c.cantidadPresupuestos + ')' : ''}`,
        icon: 'pi pi-file-edit',
        disabled: c.cantidadPresupuestos === 0,
        routerLink: ['/presupuestos/historial'],
        queryParams,
      },
      {
        label: `Ver pedidos${c.cantidadPedidos > 0 ? ' (' + c.cantidadPedidos + ')' : ''}`,
        icon: 'pi pi-receipt',
        disabled: c.cantidadPedidos === 0,
        routerLink: ['/pedidos'],
        queryParams,
      },
    ];
  }

  /** Exporta los clientes filtrados como CSV compatible con la importación
   *  de Marketing Nube (Tiendanube). Las dos primeras columnas son las que
   *  Marketing Nube reconoce automáticamente ("Correo electrónico", "Nombre");
   *  el resto son campos extras que el operador puede mapear a custom fields
   *  al importar o ignorar. UTF-8 con BOM para que Excel detecte bien los
   *  acentos al abrir el archivo. */
  exportarCsv(): void {
    const clientes = this.clientesFiltrados();
    if (clientes.length === 0) {
      this.toast.add({
        severity: 'warn',
        summary: 'Sin clientes',
        detail: 'No hay clientes para exportar.',
        life: 3000,
      });
      return;
    }
    const headers = [
      'Correo electrónico',
      'Nombre',
      'Teléfono',
      'Rubro',
    ];
    const rows = clientes.map((c) => [
      c.email ?? '',
      c.nombre ?? '',
      c.telefono ?? '',
      c.rubro ?? '',
    ]);
    const csv = [headers, ...rows].map((row) => row.map(escaparCsv).join(',')).join('\r\n');
    // BOM UTF-8 — sin esto Excel abre el CSV en latin1 y rompe los acentos.
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const fecha = new Date().toISOString().slice(0, 10);
    a.download = `clientes-kt-${fecha}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    this.toast.add({
      severity: 'success',
      summary: 'Exportado',
      detail: `${clientes.length} cliente(s) exportados al CSV.`,
      life: 3000,
    });
  }
}

/** Escapa un campo CSV: si contiene coma, comilla o salto de línea lo
 *  envolvemos en comillas y duplicamos las comillas internas. Es la regla
 *  RFC 4180 que Excel y Marketing Nube esperan. */
function escaparCsv(valor: string): string {
  if (valor.includes(',') || valor.includes('"') || valor.includes('\n') || valor.includes('\r')) {
    return '"' + valor.replace(/"/g, '""') + '"';
  }
  return valor;
}
