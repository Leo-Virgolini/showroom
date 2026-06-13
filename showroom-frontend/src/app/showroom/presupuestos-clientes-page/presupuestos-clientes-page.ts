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
import { ActivatedRoute, Router } from '@angular/router';
import { Subject, Subscription, debounceTime } from 'rxjs';
import { ConfirmationService, MessageService } from 'primeng/api';
import { AutoCompleteCompleteEvent, AutoCompleteModule } from 'primeng/autocomplete';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { DialogModule } from 'primeng/dialog';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { InputMaskModule } from 'primeng/inputmask';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { TableLazyLoadEvent, TableModule } from 'primeng/table';
import { TextareaModule } from 'primeng/textarea';
import { TooltipModule } from 'primeng/tooltip';
import { ActualizarClienteRequest, ClienteAutocompletar, ClientePresupuestos, Localidad, Provincia } from '../models';
import { calcularSugerenciasEmail } from '../email-suggestions.utils';
import { ShowroomService } from '../showroom.service';
import { sortDesdeLazyLoad } from '../tabla.utils';
import { toastError } from '../toast.utils';
import { crearTelefonoLookup } from '../telefono-lookup.util';
import { PageHeader } from '../page-header/page-header';

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
    AutoCompleteModule,
    ButtonModule,
    CardModule,
    DialogModule,
    IconFieldModule,
    InputIconModule,
    InputMaskModule,
    InputNumberModule,
    InputTextModule,
    SelectModule,
    TableModule,
    TextareaModule,
    TooltipModule,
    PageHeader,
  ],
  templateUrl: './presupuestos-clientes-page.html',
  styleUrl: './presupuestos-clientes-page.scss',
})
export class PresupuestosClientesPage {
  private readonly api = inject(ShowroomService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly toast = inject(MessageService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly confirmationService = inject(ConfirmationService);


  readonly cargando = signal(false);
  readonly clientes = signal<ClientePresupuestos[]>([]);
  readonly busqueda = signal('');

  // ---- Paginación server-side (lazy) ----
  readonly total = signal(0);
  readonly pageSize = signal(25);
  readonly first = signal(0);
  /** Campo de orden — coincide con los keys de `SORT_CLIENTES` del backend. */
  readonly sortField = signal<string>('ultimoMovimientoAt');
  readonly sortOrder = signal<'asc' | 'desc'>('desc');

  /** Filas seleccionadas con el checkbox — para el borrado masivo. */
  readonly seleccionados = signal<ClientePresupuestos[]>([]);

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
  /** True cuando el diálogo está en modo ALTA (cliente nuevo) en vez de edición.
   *  En alta el teléfono (clave del cliente) es editable. */
  readonly modoNuevo = signal(false);
  /** Teléfono tipeado en modo alta (en edición el teléfono es la clave fija). */
  readonly editTelefono = signal('');
  /** Cliente que YA tiene el teléfono tipeado en alta (null = libre) — aviso. */
  readonly telefonoExistente = signal<ClienteAutocompletar | null>(null);

  /** ngModelChange del teléfono en alta: setea + chequea si ya existe. La lógica
   *  (normalización + dedupe + guard de respuesta tardía) vive en
   *  {@link crearTelefonoLookup}, compartida con /presupuestos. */
  onEditTelefonoChange(value: string | null | undefined): void {
    this.editTelefono.set(value ?? '');
    this.chequearTelefono(value ?? '');
  }

  private readonly chequearTelefono = crearTelefonoLookup(
    (d) => this.api.buscarClientePorTelefono(d),
    this.destroyRef,
    (cli) => this.telefonoExistente.set(cli),
  );
  readonly editRazonSocial = signal('');
  readonly editNombre = signal('');
  readonly editEmail = signal('');
  readonly editRubro = signal<string | null>(null);
  readonly editRubroOtros = signal('');
  readonly editNotas = signal('');
  // Datos de facturación y envío.
  readonly editNroDoc = signal<number | null>(null);
  /** Sugerencias del autocomplete de email (mismos dominios que el modal de pedido). */
  readonly sugerenciasEmail = signal<string[]>([]);

  /** Valor (string de dígitos) que ve el inputMask del CUIT, derivado de editNroDoc. */
  readonly editCuitInputValue = computed(() => {
    const n = this.editNroDoc();
    return n != null ? String(n) : '';
  });

  /** completeMethod del autocomplete de email. */
  onCompletarEmail(event: AutoCompleteCompleteEvent): void {
    this.sugerenciasEmail.set(calcularSugerenciasEmail(event.query));
  }

  /** Recibe el valor desenmascarado del CUIT (solo dígitos) y lo guarda como number. */
  onEditCuitChange(value: string | null | undefined): void {
    const digits = (value ?? '').replace(/\D/g, '');
    this.editNroDoc.set(digits ? Number(digits) : null);
  }
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

  /** Dispara la recarga (reseteando a la primera página) cuando cambia la
   *  búsqueda. Debounce para que tipear no pegue una request por tecla — la
   *  búsqueda ahora es server-side. */
  private readonly filtroTrigger$ = new Subject<void>();
  /** Salta el primer disparo del effect (los signals ya tienen valor al montar,
   *  así que el effect corre una vez sin cambio real). Evita el doble request
   *  inicial junto con onLazyLoad. */
  private filtrosInicializados = false;

  constructor() {
    // Pre-llena la búsqueda con el queryParam `q` cuando se navega desde un
    // historial ("Ver ficha del cliente" en pedidos/presupuestos). La búsqueda
    // server-side matchea por nombre/razón social/email/teléfono/CUIT.
    const qParam = this.route.snapshot.queryParamMap.get('q');
    if (qParam) {
      this.busqueda.set(qParam);
    }

    this.filtroTrigger$
      .pipe(debounceTime(300), takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.first.set(0);
        this.cargar(0, this.pageSize());
      });

    effect(() => {
      this.busqueda();
      if (!this.filtrosInicializados) {
        this.filtrosInicializados = true;
        return;
      }
      this.filtroTrigger$.next();
    });
    // La carga inicial la dispara el (onLazyLoad) de la tabla al montar.
  }

  onLazyLoad(event: TableLazyLoadEvent): void {
    const size = event.rows ?? this.pageSize();
    const first = event.first ?? 0;
    this.pageSize.set(size);
    this.first.set(first);
    const { sortField, sortOrder } = sortDesdeLazyLoad(event, this.sortField(), this.sortOrder());
    this.sortField.set(sortField);
    this.sortOrder.set(sortOrder);
    this.cargar(Math.floor(first / size), size);
  }

  private cargar(page: number, size: number): void {
    this.cargando.set(true);
    this.api
      .listarClientesPresupuestos({
        q: this.busqueda(),
        page,
        size,
        sortField: this.sortField(),
        sortOrder: this.sortOrder(),
      })
      .subscribe({
        next: (res) => {
          this.cargando.set(false);
          this.clientes.set(res.items);
          this.total.set(res.total);
        },
        error: (err) => {
          this.cargando.set(false);
          toastError(this.toast, 'Clientes', err,
            'No se pudieron cargar los clientes.');
        },
      });
  }

  refrescar(): void {
    this.cargar(Math.floor(this.first() / this.pageSize()), this.pageSize());
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
        // Update optimista: lo sacamos de la página local y bajamos el total.
        this.clientes.set(this.clientes().filter((x) => x.telefono !== telefono));
        this.total.update((t) => Math.max(0, t - 1));
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

  /** Borra (oculta) en lote los clientes seleccionados con el checkbox. */
  eliminarSeleccionados(): void {
    const sel = this.seleccionados().filter((c) => c.telefono);
    if (sel.length === 0) return;
    const n = sel.length;
    this.confirmationService.confirm({
      header: `¿Eliminar ${n} cliente${n === 1 ? '' : 's'}?`,
      message: `Se ${n === 1 ? 'va' : 'van'} a ocultar ${n} cliente${n === 1 ? '' : 's'} de esta lista. ` +
        'El historial (presupuestos/pedidos) NO se borra. ¿Confirmás?',
      icon: 'pi pi-exclamation-triangle',
      acceptButtonProps: { label: 'Eliminar', severity: 'danger', icon: 'pi pi-trash' },
      rejectButtonProps: { label: 'Cancelar', severity: 'secondary', outlined: true },
      accept: () => this.ejecutarEliminarMasivo(sel),
    });
  }

  private ejecutarEliminarMasivo(sel: ClientePresupuestos[]): void {
    const telefonos = sel.map((c) => c.telefono).filter((t): t is string => !!t);
    if (telefonos.length === 0) return;
    this.api.eliminarClientesMasivo(telefonos).subscribe({
      next: (res) => {
        const borrados = new Set(telefonos);
        this.clientes.set(this.clientes().filter((x) => !borrados.has(x.telefono ?? '')));
        this.total.update((t) => Math.max(0, t - res.eliminados));
        this.seleccionados.set([]);
        this.toast.add({
          severity: 'success',
          summary: 'Clientes eliminados',
          detail: `${res.eliminados} cliente${res.eliminados === 1 ? '' : 's'} ocultado${res.eliminados === 1 ? '' : 's'}. El historial sigue intacto.`,
          life: 3500,
        });
      },
      error: (err) => toastError(this.toast, 'Eliminar clientes', err,
        'No se pudieron eliminar los clientes.'),
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
  /** Abre el diálogo en modo ALTA: campos vacíos y teléfono editable (es la
   *  clave del nuevo cliente). Al guardar se crea un ClienteMaster nuevo. */
  abrirDialogNuevo(): void {
    this.modoNuevo.set(true);
    this.clienteEditando.set(null);
    this.editTelefono.set('');
    // Resetea el dedupe interno del lookup y limpia el aviso (teléfono < 8 → null).
    this.chequearTelefono('');
    this.editRazonSocial.set('');
    this.editNombre.set('');
    this.editEmail.set('');
    this.editNotas.set('');
    this.editRubro.set(null);
    this.editRubroOtros.set('');
    this.editNroDoc.set(null);
    this.editDomicilio.set('');
    this.editCodigoProvincia.set(null);
    this.editIdLocalidad.set(null);
    this.localidades.set([]);
    this.cargarProvincias();
    this.mostrarDialogEditar.set(true);
  }

  abrirDialogEditar(c: ClientePresupuestos): void {
    this.modoNuevo.set(false);
    this.clienteEditando.set(c);
    this.editRazonSocial.set(c.razonSocial ?? '');
    this.editNombre.set(c.nombre ?? '');
    this.editEmail.set(c.email ?? '');
    this.editNotas.set(c.notas ?? '');
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
    this.modoNuevo.set(false);
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
    // En alta el teléfono lo tipea el operador (clave del nuevo cliente); en
    // edición es la clave fija del cliente existente.
    const telefono = this.modoNuevo()
      ? this.editTelefono().trim()
      : (this.clienteEditando()?.telefono ?? '');
    if (!telefono) {
      this.toast.add({
        severity: 'warn',
        summary: 'Falta el teléfono',
        detail: 'El teléfono es obligatorio: es la clave del cliente.',
        life: 3500,
      });
      return;
    }
    this.guardandoEdicion.set(true);
    // En ALTA: el teléfono es la clave. Verificamos que NO pertenezca ya a otro
    // cliente (sino el upsert lo sobrescribiría sin avisar). Si existe, abortamos.
    if (this.modoNuevo()) {
      this.api.buscarClientePorTelefono(telefono).subscribe((existente) => {
        if (existente) {
          this.guardandoEdicion.set(false);
          const nombre = existente.razonSocial || existente.nombre || 'otro cliente';
          this.toast.add({
            severity: 'error',
            summary: 'Teléfono ya registrado',
            detail: `Ya existe un cliente con ese teléfono: ${nombre}. Editalo desde la lista en vez de crear uno nuevo.`,
            life: 6000,
          });
          return;
        }
        this.ejecutarGuardar(telefono);
      });
      return;
    }
    this.ejecutarGuardar(telefono);
  }

  /** Construye el payload y lo guarda (alta o edición ya validada). */
  private ejecutarGuardar(telefono: string): void {
    const payload: ActualizarClienteRequest = {
      telefono,
      razonSocial: this.editRazonSocial().trim() || null,
      nombre: this.editNombre().trim() || null,
      email: this.editEmail().trim() || null,
      rubro: this.rubroFinalEdicion(),
      notas: this.editNotas().trim() || null,
      // El documento del cliente siempre es CUIT (el modal de pedido y DUX
      // trabajan con CUIT); no se pregunta el tipo.
      tipoDoc: this.editNroDoc() != null ? 'CUIT' : null,
      nroDoc: this.editNroDoc(),
      domicilio: this.editDomicilio().trim() || null,
      codigoProvincia: this.editCodigoProvincia(),
      idLocalidad: this.editIdLocalidad(),
    };
    this.api.actualizarClienteMaster(payload).subscribe({
      next: () => {
        const eraNuevo = this.modoNuevo();
        this.guardandoEdicion.set(false);
        this.mostrarDialogEditar.set(false);
        this.clienteEditando.set(null);
        this.modoNuevo.set(false);
        this.toast.add({
          severity: 'success',
          summary: eraNuevo ? 'Cliente creado' : 'Cliente actualizado',
          detail: eraNuevo
            ? 'El cliente nuevo se agregó al maestro.'
            : 'Los datos del cliente se guardaron en el maestro.',
          life: 3000,
        });
        // Refrescamos la página actual para que aparezca el nuevo / se apliquen
        // los cambios (la lista es server-side ahora).
        this.refrescar();
      },
      error: (err) => {
        this.guardandoEdicion.set(false);
        toastError(this.toast, 'Editar cliente', err,
          'No se pudo guardar el cliente.');
      },
    });
  }

  /** True mientras se baja el conjunto completo para el export. */
  readonly exportando = signal(false);

  /** Exporta TODOS los clientes que matchean la búsqueda actual (no solo la
   *  página visible) como CSV compatible con Marketing Nube (Tiendanube). Como
   *  la tabla ahora pagina en el servidor, pedimos el set completo a un endpoint
   *  dedicado antes de generar el archivo. */
  exportarCsv(): void {
    if (this.exportando()) return;
    this.exportando.set(true);
    this.api.exportarClientesPresupuestos(this.busqueda()).subscribe({
      next: (clientes) => {
        this.exportando.set(false);
        if (clientes.length === 0) {
          this.toast.add({
            severity: 'warn',
            summary: 'Sin clientes',
            detail: 'No hay clientes para exportar.',
            life: 3000,
          });
          return;
        }
        this.generarYDescargarCsv(clientes);
      },
      error: (err) => {
        this.exportando.set(false);
        toastError(this.toast, 'Exportar CSV', err, 'No se pudo exportar el CSV.');
      },
    });
  }

  /** Construye el CSV (UTF-8 con BOM para que Excel respete los acentos) y lo
   *  descarga. Las dos primeras columnas son las que Marketing Nube reconoce
   *  automáticamente ("Correo electrónico", "Nombre"); el resto son extras. */
  private generarYDescargarCsv(clientes: ClientePresupuestos[]): void {
    const headers = [
      'Correo electrónico',
      'Nombre',
      'Apellido / razón social',
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
      c.razonSocial ?? '',
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
