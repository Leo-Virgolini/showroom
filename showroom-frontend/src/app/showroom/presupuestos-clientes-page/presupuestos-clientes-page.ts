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
import { Subscription } from 'rxjs';
import { ConfirmationService, MessageService } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { DialogModule } from 'primeng/dialog';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { TableModule } from 'primeng/table';
import { TextareaModule } from 'primeng/textarea';
import { ToolbarModule } from 'primeng/toolbar';
import { TooltipModule } from 'primeng/tooltip';
import { ActualizarClienteRequest, ClientePresupuestos, Localidad, Provincia } from '../models';
import { ShowroomService } from '../showroom.service';
import { toastError } from '../toast.utils';
import { TopActions } from '../top-actions/top-actions';

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
    DialogModule,
    IconFieldModule,
    InputIconModule,
    InputNumberModule,
    InputTextModule,
    SelectModule,
    TableModule,
    TextareaModule,
    ToolbarModule,
    TooltipModule,
    TopActions,
  ],
  templateUrl: './presupuestos-clientes-page.html',
})
export class PresupuestosClientesPage {
  private readonly api = inject(ShowroomService);
  private readonly toast = inject(MessageService);
  private readonly router = inject(Router);
  private readonly confirmationService = inject(ConfirmationService);

  readonly screenLg = signal(
    typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches,
  );

  readonly cargando = signal(false);
  readonly clientes = signal<ClientePresupuestos[]>([]);
  readonly busqueda = signal('');

  /** Teléfonos en proceso de soft-delete — se usa para mostrar spinner en el
   *  botón de borrar y evitar doble click mientras la request está en vuelo. */
  readonly eliminando = signal<Set<string>>(new Set());

  // ---------- Dialog "Editar cliente" ----------
  // El operador puede corregir nombre/email/rubro/notas del cliente sin
  // tocar los presupuestos/pedidos históricos. El backend persiste un
  // ClienteMaster por teléfono que pisa los datos derivados del historial
  // al armar este listado.
  readonly mostrarDialogEditar = signal(false);
  readonly guardandoEdicion = signal(false);
  readonly clienteEditando = signal<ClientePresupuestos | null>(null);
  readonly editNombre = signal('');
  readonly editEmail = signal('');
  readonly editRubro = signal<string | null>(null);
  readonly editRubroOtros = signal('');
  readonly editNotas = signal('');
  // Datos de facturación y envío.
  readonly editTipoDoc = signal<string | null>(null);
  readonly editNroDoc = signal<number | null>(null);
  readonly editDomicilio = signal('');
  readonly editCodigoProvincia = signal<string | null>(null);
  readonly editIdLocalidad = signal<string | null>(null);

  /** Catálogos para los selects de envío. Provincias se cargan al abrir el
   *  dialog; localidades en cascada al elegir provincia (o al pre-cargar un
   *  cliente que ya tenía provincia). Mismo patrón que crear-pedido-dialog. */
  readonly provincias = signal<Provincia[]>([]);
  readonly localidades = signal<Localidad[]>([]);
  readonly cargandoLocalidades = signal(false);
  private localidadesSub: Subscription | null = null;

  readonly opcionesTipoDoc: { label: string; value: string }[] = [
    { label: 'CUIT', value: 'CUIT' },
    { label: 'DNI', value: 'DNI' },
    { label: 'CUIL', value: 'CUIL' },
  ];

  /** Opciones del dropdown de rubro — mismo set que /presupuestos y el modal
   *  de pedidos para que un mismo cliente caiga al mismo rubro en cualquier
   *  flujo. "Otros…" habilita un input libre. */
  readonly opcionesRubro: { label: string; value: string }[] = [
    { label: 'Bar', value: 'bar' },
    { label: 'Restaurant', value: 'restaurant' },
    { label: 'Catering', value: 'catering' },
    { label: 'Cafetería', value: 'cafeteria' },
    { label: 'Panadería', value: 'panaderia' },
    { label: 'Pastelería', value: 'pasteleria' },
    { label: 'Otros…', value: 'otros' },
  ];

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

  estaEliminando(telefono: string | null | undefined): boolean {
    return telefono != null && this.eliminando().has(telefono);
  }

  /** Pide confirmación antes del soft-delete — el cliente se oculta de esta
   *  vista pero los presupuestos/pedidos históricos siguen intactos en sus
   *  propias pantallas. Reactivable editando el cliente. */
  confirmarEliminar(c: ClientePresupuestos): void {
    if (!c.telefono || this.estaEliminando(c.telefono)) return;
    const refNombre = c.nombre ? ` "${c.nombre}"` : '';
    const resumenMov: string[] = [];
    if (c.cantidadPresupuestos > 0) {
      resumenMov.push(`${c.cantidadPresupuestos} presupuesto${c.cantidadPresupuestos === 1 ? '' : 's'}`);
    }
    if (c.cantidadPedidos > 0) {
      resumenMov.push(`${c.cantidadPedidos} pedido${c.cantidadPedidos === 1 ? '' : 's'}`);
    }
    const aviso = resumenMov.length > 0
      ? `Tiene ${resumenMov.join(' y ')} en el historial — esos registros NO se borran, solo se oculta al cliente de esta lista.`
      : 'Se va a ocultar al cliente de esta lista.';
    this.confirmationService.confirm({
      header: '¿Eliminar cliente?',
      message: `Vas a eliminar al cliente${refNombre}. ${aviso} ¿Confirmás?`,
      icon: 'pi pi-exclamation-triangle',
      acceptButtonProps: { label: 'Eliminar', severity: 'danger', icon: 'pi pi-trash' },
      rejectButtonProps: { label: 'Cancelar', severity: 'secondary', outlined: true },
      accept: () => this.ejecutarEliminar(c),
    });
  }

  private ejecutarEliminar(c: ClientePresupuestos): void {
    const telefono = c.telefono;
    if (!telefono) return;
    this.eliminando.update((s) => new Set([...s, telefono]));
    this.api.eliminarClienteMaster(telefono).subscribe({
      next: () => {
        this.eliminando.update((s) => {
          const ns = new Set(s);
          ns.delete(telefono);
          return ns;
        });
        // Update optimista: lo sacamos del listado local sin pedir refetch.
        this.clientes.set(this.clientes().filter((x) => x.telefono !== telefono));
        this.toast.add({
          severity: 'success',
          summary: 'Cliente eliminado',
          detail: 'Ya no aparece en el listado. El historial sigue intacto.',
          life: 3500,
        });
      },
      error: (err) => {
        this.eliminando.update((s) => {
          const ns = new Set(s);
          ns.delete(telefono);
          return ns;
        });
        toastError(this.toast, 'Eliminar cliente', err,
          'No se pudo eliminar el cliente.');
      },
    });
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

  /** Abre el dialog de edición con los valores actuales del cliente. Si el
   *  rubro guardado no es uno de los predefinidos, lo tratamos como "otros"
   *  con texto libre — mismo comportamiento que /presupuestos. */
  abrirDialogEditar(c: ClientePresupuestos): void {
    this.clienteEditando.set(c);
    this.editNombre.set(c.nombre ?? '');
    this.editEmail.set(c.email ?? '');
    this.editNotas.set('');
    const rubroActual = c.rubro ?? '';
    const esPredefinido = this.opcionesRubro.some((o) => o.value === rubroActual);
    if (rubroActual && !esPredefinido) {
      this.editRubro.set('otros');
      this.editRubroOtros.set(rubroActual);
    } else {
      this.editRubro.set(rubroActual || null);
      this.editRubroOtros.set('');
    }
    // Datos de facturación/envío.
    this.editTipoDoc.set(c.tipoDoc ?? null);
    this.editNroDoc.set(c.nroDoc ?? null);
    this.editDomicilio.set(c.domicilio ?? '');
    this.editCodigoProvincia.set(c.codigoProvincia ?? null);
    this.editIdLocalidad.set(c.idLocalidad ?? null);
    this.localidades.set([]);
    this.cargarProvincias();
    // Si ya tenía provincia, traemos sus localidades preservando la selección
    // actual (no usamos cambiarProvincia porque ese resetea la localidad).
    if (c.codigoProvincia) {
      this.cargarLocalidadesDe(c.codigoProvincia);
    }
    this.mostrarDialogEditar.set(true);
  }

  cerrarDialogEditar(): void {
    this.localidadesSub?.unsubscribe();
    this.localidadesSub = null;
    this.cargandoLocalidades.set(false);
    this.mostrarDialogEditar.set(false);
    this.clienteEditando.set(null);
  }

  /** Carga las provincias una sola vez (se reusan entre aperturas del dialog). */
  private cargarProvincias(): void {
    if (this.provincias().length > 0) return;
    this.api.obtenerProvincias().subscribe({
      next: (lista) => this.provincias.set(lista),
      error: (err) =>
        toastError(this.toast, 'Provincias', err, 'No se pudieron cargar las provincias'),
    });
  }

  /** Trae las localidades de una provincia SIN tocar la localidad seleccionada
   *  — usado al pre-cargar un cliente que ya tenía provincia/localidad. */
  private cargarLocalidadesDe(codigo: string): void {
    this.localidadesSub?.unsubscribe();
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

  /** Cambio de provincia disparado por el operador: resetea la localidad y
   *  recarga el catálogo. */
  cambiarProvincia(codigo: string | null): void {
    this.editCodigoProvincia.set(codigo);
    this.editIdLocalidad.set(null);
    this.localidades.set([]);
    if (!codigo) {
      this.localidadesSub?.unsubscribe();
      this.localidadesSub = null;
      this.cargandoLocalidades.set(false);
      return;
    }
    this.cargarLocalidadesDe(codigo);
  }

  /** Resuelve el rubro final: si el operador eligió "otros" usa el texto
   *  libre; sino devuelve la opción predefinida. Null si no completó. */
  private rubroFinalEdicion(): string | null {
    const r = this.editRubro();
    if (!r) return null;
    if (r === 'otros') {
      const libre = this.editRubroOtros().trim();
      return libre || null;
    }
    return r;
  }

  guardarEdicion(): void {
    const c = this.clienteEditando();
    if (!c || !c.telefono) return;
    const payload: ActualizarClienteRequest = {
      telefono: c.telefono,
      nombre: this.editNombre().trim() || null,
      email: this.editEmail().trim() || null,
      rubro: this.rubroFinalEdicion(),
      notas: this.editNotas().trim() || null,
      tipoDoc: this.editTipoDoc(),
      nroDoc: this.editNroDoc(),
      domicilio: this.editDomicilio().trim() || null,
      codigoProvincia: this.editCodigoProvincia(),
      idLocalidad: this.editIdLocalidad(),
    };
    this.guardandoEdicion.set(true);
    this.api.actualizarClienteMaster(payload).subscribe({
      next: () => {
        this.guardandoEdicion.set(false);
        this.mostrarDialogEditar.set(false);
        this.clienteEditando.set(null);
        this.toast.add({
          severity: 'success',
          summary: 'Cliente actualizado',
          detail: 'Los datos del cliente se guardaron en el maestro.',
          life: 3000,
        });
        // Refrescamos la tabla para que el merge aplique los nuevos overrides.
        this.cargar();
      },
      error: (err) => {
        this.guardandoEdicion.set(false);
        toastError(this.toast, 'Editar cliente', err,
          'No se pudo guardar el cliente.');
      },
    });
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
      'CUIT',
      'Domicilio',
      'Localidad',
      'Provincia',
    ];
    const rows = clientes.map((c) => [
      c.email ?? '',
      c.nombre ?? '',
      c.telefono ?? '',
      c.rubro ?? '',
      c.nroDoc != null ? String(c.nroDoc) : '',
      c.domicilio ?? '',
      c.localidadNombre ?? '',
      c.provinciaNombre ?? '',
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
