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
import { ConfirmationService, MessageService } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { CheckboxModule } from 'primeng/checkbox';
import { DatePickerModule } from 'primeng/datepicker';
import { DialogModule } from 'primeng/dialog';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { MultiSelectModule } from 'primeng/multiselect';
import { TableModule } from 'primeng/table';
import { TabsModule } from 'primeng/tabs';
import { TextareaModule } from 'primeng/textarea';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { ToolbarModule } from 'primeng/toolbar';
import { TooltipModule } from 'primeng/tooltip';
import { AuthService, Usuario } from '../../auth/auth.service';
import { EscalaDescuento, FormaPago, HorarioSync, NotificacionesAutoConfig, PickitConfig } from '../models';
import { MoreMenu } from '../more-menu/more-menu';
import { ShowroomService } from '../showroom.service';
import { toastError } from '../toast.utils';
import { UserChip } from '../user-chip/user-chip';

/**
 * Fila editable de la tabla de escalones. {@code umbralMin} y {@code porcentaje}
 * pueden ser null mientras el operador está completando — solo se valida al
 * guardar.
 */
interface FilaEscala {
  umbralMin: number | null;
  porcentaje: number | null;
}

/**
 * Fila editable de la tabla de horarios. Internamente la guardamos como
 * {@code Date} para que el {@code p-datePicker} con {@code timeOnly} la
 * pueda atar directo con {@code [(ngModel)]}. Solo nos importan las horas
 * y minutos — la fecha base no se usa. Null = fila recién agregada sin
 * completar.
 */
interface FilaHorario {
  tiempo: Date | null;
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
    CheckboxModule,
    DatePickerModule,
    DialogModule,
    IconFieldModule,
    InputIconModule,
    InputNumberModule,
    InputTextModule,
    MultiSelectModule,
    TableModule,
    TabsModule,
    TextareaModule,
    ToggleSwitchModule,
    ToolbarModule,
    TooltipModule,
    MoreMenu,
    UserChip,
  ],
  templateUrl: './configuracion-page.html',
  styleUrl: './configuracion-page.scss',
})
export class ConfiguracionPage {
  private readonly api = inject(ShowroomService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(MessageService);
  private readonly confirmationService = inject(ConfirmationService);

  // ============================================================
  // Escalones de descuento
  // ============================================================
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

  // ============================================================
  // Horarios de sincronización automática con DUX
  // ============================================================
  readonly cargandoHorarios = signal(false);
  readonly guardandoHorarios = signal(false);
  readonly horarios = signal<FilaHorario[]>([]);

  /** Snapshot de los horarios como vinieron del backend — para el "deshacer". */
  private readonly horariosOriginal = signal<FilaHorario[]>([]);

  readonly hayCambiosHorarios = computed(() => {
    const a = this.horarios();
    const b = this.horariosOriginal();
    if (a.length !== b.length) return true;
    return a.some((fila, i) => {
      const ta = fila.tiempo;
      const tb = b[i].tiempo;
      if (ta == null || tb == null) return ta !== tb;
      return ta.getHours() !== tb.getHours() || ta.getMinutes() !== tb.getMinutes();
    });
  });

  // ============================================================
  // Pickit externo (programa pickit-y-etiquetas)
  // ============================================================
  readonly cargandoPickit = signal(false);
  readonly guardandoPickit = signal(false);
  /** Estado editable de la config. */
  readonly pickitConfig = signal<PickitConfig>({
    enabled: false,
    jarPath: '',
    stockFile: '',
    combosFile: '',
    outputDir: '',
  });
  /** Snapshot del backend para detectar cambios y permitir deshacer. */
  private readonly pickitConfigOriginal = signal<PickitConfig>({
    enabled: false,
    jarPath: '',
    stockFile: '',
    combosFile: '',
    outputDir: '',
  });

  readonly hayCambiosPickit = computed(() => {
    const a = this.pickitConfig();
    const b = this.pickitConfigOriginal();
    return (
      a.enabled !== b.enabled ||
      a.jarPath.trim() !== b.jarPath.trim() ||
      a.stockFile.trim() !== b.stockFile.trim() ||
      a.combosFile.trim() !== b.combosFile.trim() ||
      a.outputDir.trim() !== b.outputDir.trim()
    );
  });

  // ============================================================
  // Usuarios (CRUD)
  // ============================================================
  readonly cargandoUsuarios = signal(false);
  readonly usuarios = signal<Usuario[]>([]);

  /** Dialog para crear/editar usuario. null = cerrado. */
  readonly usuarioEditar = signal<Usuario | null>(null);
  readonly mostrarDialogUsuario = signal(false);
  readonly modoEdicionUsuario = signal<'crear' | 'editar'>('crear');
  readonly guardandoUsuario = signal(false);
  readonly formUsername = signal('');
  readonly formPassword = signal('');
  readonly formNombre = signal('');
  readonly formActivo = signal(true);
  readonly mostrarFormPassword = signal(false);

  // ============================================================
  // Notificaciones automáticas tras pedido (email + whatsapp)
  // ============================================================
  readonly cargandoNotificacionesAuto = signal(false);
  readonly guardandoNotificacionesAuto = signal(false);
  /** Si null, todavía no cargó del backend — los switches se muestran disabled. */
  readonly notificacionesAuto = signal<NotificacionesAutoConfig | null>(null);

  // ============================================================
  // Mensaje de WhatsApp (caption del PDF) — editable
  // ============================================================
  readonly cargandoWhatsappMensaje = signal(false);
  readonly guardandoWhatsappMensaje = signal(false);
  /** Texto editable en el textarea (estado local). */
  readonly whatsappMensaje = signal('');
  /** Snapshot del último valor cargado/guardado — para detectar cambios. */
  private readonly whatsappMensajeOriginal = signal('');
  /** Flag del backend: false = no hay mensaje configurado en DB (el PDF se va a
   *  mandar sin caption). true = el operador cargó un mensaje desde esta misma
   *  pantalla. */
  readonly whatsappMensajePersonalizado = signal(false);

  /** WhatsApp limita el caption a 1024 chars — lo usamos como hard cap del
   *  textarea para que el operador vea el contador en vivo. */
  static readonly WHATSAPP_CAPTION_MAX = 1024;
  /** Alias accesible desde el template (los static no son visibles ahí). */
  readonly MAX_CAPTION = ConfiguracionPage.WHATSAPP_CAPTION_MAX;

  readonly hayCambiosWhatsappMensaje = computed(
    () => this.whatsappMensaje() !== this.whatsappMensajeOriginal(),
  );

  /** Preview HTML del mensaje renderizado como lo va a ver el cliente en
   *  WhatsApp. Aplica *bold* / _italic_ / ~strike~ / `mono` y reemplaza
   *  {nombre} por un nombre de ejemplo. Es seguro: escapamos HTML primero y
   *  recién después insertamos las tags de formato. */
  readonly whatsappPreviewHtml = computed(() =>
    ConfiguracionPage.renderWhatsappPreview(this.whatsappMensaje()),
  );

  readonly whatsappCaracteres = computed(() => this.whatsappMensaje().length);

  // ============================================================
  // Toggle global de sync automática con DUX
  // ============================================================
  readonly cargandoSyncAuto = signal(false);
  readonly guardandoSyncAuto = signal(false);
  /** Si null, todavía no cargó. Default a `true` desde el backend. */
  readonly syncAutoHabilitada = signal<boolean | null>(null);

  // ============================================================
  // URL base del visor (para el QR) — editable
  // ============================================================
  readonly cargandoVisor = signal(false);
  readonly guardandoVisor = signal(false);
  /** Dirección con la que se arma el QR del visor. Vacío = usa el origin del
   *  navegador (la dirección con la que el operador abrió la app). */
  readonly visorBaseUrl = signal('');
  private readonly visorBaseUrlOriginal = signal('');
  readonly hayCambiosVisor = computed(
    () => this.visorBaseUrl().trim() !== this.visorBaseUrlOriginal().trim(),
  );

  // ============================================================
  // Formas de pago — CRUD
  // ============================================================
  readonly cargandoFormasPago = signal(false);
  readonly formasPago = signal<FormaPago[]>([]);

  /** Dialog para crear/editar forma de pago. null = cerrado. */
  readonly formaEditar = signal<FormaPago | null>(null);
  readonly mostrarDialogForma = signal(false);
  readonly modoEdicionForma = signal<'crear' | 'editar'>('crear');
  readonly guardandoForma = signal(false);
  readonly formNombrePago = signal('');
  readonly formRecargo = signal<number | null>(0);
  /** Perfil maquinaria: recargo (null = usa el normal) y aplica IVA. */
  readonly formRecargoMaquinaria = signal<number | null>(null);
  readonly formAplicaIvaMaquinaria = signal(false);
  readonly formCuotas = signal<number | null>(1);
  readonly formAplicaIva = signal(true);
  readonly formActivoPago = signal(true);
  readonly formPrecioReferencia = signal(false);
  readonly formOrden = signal<number | null>(0);

  // Rubros que cotizan sin IVA (precio base = PVP sin IVA)
  readonly cargandoRubrosSinIva = signal(false);
  readonly guardandoRubrosSinIva = signal(false);
  /** Rubros disponibles en DUX (opciones del multiselect). */
  readonly rubrosDisponibles = signal<string[]>([]);
  /** Rubros seleccionados que cotizan sin IVA. */
  readonly rubrosSinIvaSeleccionados = signal<string[]>([]);
  /** Opciones del multiselect: rubros de DUX + los seleccionados que ya no existan. */
  readonly rubrosOpciones = computed(() => {
    const set = new Set<string>(this.rubrosDisponibles());
    for (const r of this.rubrosSinIvaSeleccionados()) set.add(r);
    return [...set].sort((a, b) => a.localeCompare(b));
  });


  constructor() {
    this.cargar();
    this.cargarHorarios();
    this.cargarPickit();
    this.cargarUsuarios();
    this.cargarFormasPago();
    this.cargarRubrosSinIva();
    this.cargarNotificacionesAuto();
    this.cargarSyncAuto();
    this.cargarWhatsappMensaje();
    this.cargarVisor();
  }

  // ============================================================
  // URL base del visor — métodos
  // ============================================================

  private cargarVisor(): void {
    this.cargandoVisor.set(true);
    this.api.obtenerVisorConfig().subscribe({
      next: (cfg) => {
        this.cargandoVisor.set(false);
        this.visorBaseUrl.set(cfg.baseUrl ?? '');
        this.visorBaseUrlOriginal.set(cfg.baseUrl ?? '');
      },
      error: (err) => {
        this.cargandoVisor.set(false);
        toastError(this.toast, 'Visor', err, 'No se pudo cargar la dirección del visor');
      },
    });
  }

  descartarCambiosVisor(): void {
    this.visorBaseUrl.set(this.visorBaseUrlOriginal());
  }

  guardarVisor(): void {
    const baseUrl = this.visorBaseUrl().trim();
    if (baseUrl && !/^https?:\/\//i.test(baseUrl)) {
      this.toast.add({
        severity: 'warn',
        summary: 'Dirección inválida',
        detail: 'Debe empezar con http:// o https:// (ej. http://192.168.1.50:4200).',
        life: 4000,
      });
      return;
    }
    this.guardandoVisor.set(true);
    this.api.guardarVisorConfig({ baseUrl }).subscribe({
      next: (cfg) => {
        this.guardandoVisor.set(false);
        this.visorBaseUrl.set(cfg.baseUrl ?? '');
        this.visorBaseUrlOriginal.set(cfg.baseUrl ?? '');
        this.toast.add({
          severity: 'success',
          summary: 'Dirección del visor guardada',
          detail: cfg.baseUrl
            ? `El QR del visor va a apuntar a ${cfg.baseUrl}`
            : 'Sin dirección — el QR usa la dirección con la que abrís la app.',
          life: 3500,
        });
      },
      error: (err) => {
        this.guardandoVisor.set(false);
        toastError(this.toast, 'Guardar visor', err, 'No se pudo guardar la dirección del visor');
      },
    });
  }

  // ============================================================
  // Mensaje de WhatsApp — métodos
  // ============================================================

  private cargarWhatsappMensaje(): void {
    this.cargandoWhatsappMensaje.set(true);
    this.api.obtenerWhatsappMensaje().subscribe({
      next: (cfg) => {
        this.cargandoWhatsappMensaje.set(false);
        this.whatsappMensaje.set(cfg.mensaje ?? '');
        this.whatsappMensajeOriginal.set(cfg.mensaje ?? '');
        this.whatsappMensajePersonalizado.set(cfg.personalizado);
      },
      error: (err) => {
        this.cargandoWhatsappMensaje.set(false);
        toastError(this.toast, 'Mensaje WhatsApp', err,
          'No se pudo cargar el mensaje configurado');
      },
    });
  }

  descartarCambiosWhatsappMensaje(): void {
    this.whatsappMensaje.set(this.whatsappMensajeOriginal());
  }

  guardarWhatsappMensaje(): void {
    const mensaje = this.whatsappMensaje();
    if (mensaje.length > ConfiguracionPage.WHATSAPP_CAPTION_MAX) {
      this.toast.add({
        severity: 'warn',
        summary: 'Mensaje muy largo',
        detail: `Máximo ${ConfiguracionPage.WHATSAPP_CAPTION_MAX} caracteres (WhatsApp lo limita).`,
        life: 4000,
      });
      return;
    }
    this.guardandoWhatsappMensaje.set(true);
    this.api.guardarWhatsappMensaje({ mensaje, personalizado: true }).subscribe({
      next: (cfg) => {
        this.guardandoWhatsappMensaje.set(false);
        this.whatsappMensaje.set(cfg.mensaje ?? '');
        this.whatsappMensajeOriginal.set(cfg.mensaje ?? '');
        this.whatsappMensajePersonalizado.set(cfg.personalizado);
        this.toast.add({
          severity: 'success',
          summary: 'Mensaje guardado',
          detail: cfg.personalizado
            ? 'Se va a usar este texto en los próximos envíos por WhatsApp.'
            : 'No hay mensaje configurado — el PDF se va a mandar sin caption.',
          life: 3000,
        });
      },
      error: (err) => {
        this.guardandoWhatsappMensaje.set(false);
        toastError(this.toast, 'Guardar mensaje', err, 'No se pudo guardar el mensaje');
      },
    });
  }

  /** Borra el mensaje configurado — el PDF se va a empezar a mandar sin caption
   *  hasta que el operador configure uno nuevo. */
  quitarWhatsappMensaje(): void {
    this.confirmationService.confirm({
      header: 'Quitar mensaje',
      message: 'Se va a borrar el mensaje configurado. A partir de ahora el PDF se va a mandar sin texto en WhatsApp hasta que cargues uno nuevo. ¿Continuar?',
      icon: 'pi pi-exclamation-triangle',
      acceptButtonProps: {
        label: 'Quitar',
        icon: 'pi pi-trash',
        severity: 'danger',
      },
      rejectButtonProps: {
        label: 'Cancelar',
        severity: 'secondary',
        outlined: true,
      },
      accept: () => {
        this.guardandoWhatsappMensaje.set(true);
        this.api.guardarWhatsappMensaje({ mensaje: '', personalizado: false }).subscribe({
          next: (cfg) => {
            this.guardandoWhatsappMensaje.set(false);
            this.whatsappMensaje.set(cfg.mensaje ?? '');
            this.whatsappMensajeOriginal.set(cfg.mensaje ?? '');
            this.whatsappMensajePersonalizado.set(cfg.personalizado);
            this.toast.add({
              severity: 'success',
              summary: 'Mensaje quitado',
              detail: 'El PDF se va a mandar sin caption hasta que configures uno nuevo.',
              life: 3000,
            });
          },
          error: (err) => {
            this.guardandoWhatsappMensaje.set(false);
            toastError(this.toast, 'Quitar mensaje', err, 'No se pudo quitar el mensaje');
          },
        });
      },
    });
  }

  /** Inserta una marca de formato (negrita/itálica/etc.) envolviendo el texto
   *  seleccionado en el textarea, o insertando un placeholder ("texto") si no
   *  hay selección. Reutilizado por los 4 botones de formato del editor. */
  insertarFormatoWhatsapp(simbolo: '*' | '_' | '~' | '`', textareaId: string): void {
    const el = document.getElementById(textareaId) as HTMLTextAreaElement | null;
    if (!el) return;
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    const texto = this.whatsappMensaje();
    const seleccion = texto.substring(start, end);
    const cuerpo = seleccion || 'texto';
    const nuevo = texto.substring(0, start) + simbolo + cuerpo + simbolo + texto.substring(end);
    this.whatsappMensaje.set(nuevo);
    // Reposicionar la selección sobre el cuerpo del fragmento insertado, para
    // que el operador pueda seguir tipeando arriba si quiere. setTimeout
    // porque la signal todavía no actualizó el DOM cuando focusamos.
    setTimeout(() => {
      el.focus();
      el.setSelectionRange(start + simbolo.length, start + simbolo.length + cuerpo.length);
    }, 0);
  }

  /** Renderiza el mensaje aplicando el formato de WhatsApp para el preview.
   *  Seguro: escapa HTML primero, recién después introduce las tags. */
  private static renderWhatsappPreview(raw: string): string {
    if (!raw) return '<span class="text-muted-color italic">(mensaje vacío)</span>';
    const conNombre = raw.replace(/\{nombre\}/g, 'Juan');
    const escaped = conNombre
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
    const formateado = escaped
      .replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>')
      .replace(/_([^_\n]+)_/g, '<em>$1</em>')
      .replace(/~([^~\n]+)~/g, '<s>$1</s>')
      .replace(/`([^`\n]+)`/g, '<code class="px-1 py-0.5 rounded bg-black/10 dark:bg-white/10 text-[0.875em]">$1</code>');
    return formateado.replace(/\n/g, '<br>');
  }

  // ============================================================
  // Sync auto — métodos
  // ============================================================

  private cargarSyncAuto(): void {
    this.cargandoSyncAuto.set(true);
    this.api.obtenerSyncAuto().subscribe({
      next: (cfg) => {
        this.cargandoSyncAuto.set(false);
        this.syncAutoHabilitada.set(cfg.habilitada);
      },
      error: (err) => {
        this.cargandoSyncAuto.set(false);
        toastError(this.toast, 'Sync automática', err, 'No se pudo cargar el estado de la sync automática');
      },
    });
  }

  toggleSyncAuto(valor: boolean): void {
    const previo = this.syncAutoHabilitada();
    // Update optimista — el switch responde instantáneo.
    this.syncAutoHabilitada.set(valor);
    this.guardandoSyncAuto.set(true);
    this.api.guardarSyncAuto(valor).subscribe({
      next: (cfg) => {
        this.guardandoSyncAuto.set(false);
        this.syncAutoHabilitada.set(cfg.habilitada);
        this.toast.add({
          severity: 'success',
          summary: `Sync automática ${valor ? 'habilitada' : 'pausada'}`,
          detail: valor
            ? 'Los horarios programados van a disparar normalmente.'
            : 'Los horarios siguen configurados pero no se van a ejecutar hasta reactivar.',
          life: 3000,
        });
      },
      error: (err) => {
        this.guardandoSyncAuto.set(false);
        // Revertir optimistic.
        this.syncAutoHabilitada.set(previo);
        toastError(this.toast, 'Sync automática', err, 'No se pudo guardar el cambio');
      },
    });
  }

  // ============================================================
  // Escalones — métodos
  // ============================================================

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

  /**
   * Esquema de colores para identificar visualmente cada escalón.
   * 5 colores cíclicos (ámbar → esmeralda → cielo → violeta → rosa) —
   * el mismo orden que usa el showroom-page para mostrar los tiles
   * "Comprá más y ahorrás", así el operador asocia color → escalón
   * incluso al ver ambas pantallas.
   *
   * Devuelve las clases Tailwind para borde + fondo + pill numerador.
   */
  escalonColorScheme(i: number): { border: string; bg: string; pill: string } {
    return ESCALON_COLOR_SCHEMES[i % ESCALON_COLOR_SCHEMES.length];
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

  // ============================================================
  // Horarios — métodos
  // ============================================================

  /** Construye un Date "anclado" a hoy con la hora/minuto deseados. La fecha
   *  base es irrelevante para la UI (timeOnly), pero el datepicker necesita
   *  un Date válido para mostrar el valor. */
  private aTiempo(hora: number, minuto: number): Date {
    const d = new Date();
    d.setHours(hora, minuto, 0, 0);
    return d;
  }

  private cargarHorarios(): void {
    this.cargandoHorarios.set(true);
    this.api.obtenerHorariosSync().subscribe({
      next: (lista) => {
        this.cargandoHorarios.set(false);
        const filas: FilaHorario[] = lista.map((h) => ({
          tiempo: this.aTiempo(h.hora, h.minuto),
        }));
        this.horarios.set(filas);
        // El snapshot original guarda copias propias del Date — sin esto,
        // mutar el Date desde el datepicker contaminaría la referencia que
        // usa hayCambiosHorarios para detectar diffs.
        this.horariosOriginal.set(
          filas.map((f) => ({ tiempo: f.tiempo ? new Date(f.tiempo) : null })),
        );
      },
      error: (err) => {
        this.cargandoHorarios.set(false);
        toastError(this.toast, 'Horarios', err, 'No se pudieron cargar los horarios');
      },
    });
  }

  agregarHorario(): void {
    this.horarios.set([...this.horarios(), { tiempo: null }]);
  }

  eliminarHorario(index: number): void {
    this.horarios.set(this.horarios().filter((_, i) => i !== index));
  }

  actualizarTiempo(index: number, valor: Date | null): void {
    this.horarios.set(
      this.horarios().map((f, i) => (i === index ? { tiempo: valor } : f)),
    );
  }

  descartarCambiosHorarios(): void {
    this.horarios.set(
      this.horariosOriginal().map((f) => ({
        tiempo: f.tiempo ? new Date(f.tiempo) : null,
      })),
    );
  }

  guardarHorarios(): void {
    const filas = this.horarios();

    for (let i = 0; i < filas.length; i++) {
      const t = filas[i].tiempo;
      if (t == null) {
        this.toast.add({
          severity: 'warn',
          summary: `Horario #${i + 1} incompleto`,
          detail: 'Elegí un horario o eliminá la fila.',
          life: 4000,
        });
        return;
      }
    }
    const claves = new Set(
      filas.map((f) => `${f.tiempo!.getHours()}:${f.tiempo!.getMinutes()}`),
    );
    if (claves.size !== filas.length) {
      this.toast.add({
        severity: 'warn',
        summary: 'Horarios duplicados',
        detail: 'No puede haber dos horarios iguales.',
        life: 4000,
      });
      return;
    }

    const payload: HorarioSync[] = filas.map((f) => ({
      hora: f.tiempo!.getHours(),
      minuto: f.tiempo!.getMinutes(),
    }));

    this.guardandoHorarios.set(true);
    this.api.actualizarHorariosSync(payload).subscribe({
      next: (lista) => {
        this.guardandoHorarios.set(false);
        const nuevos: FilaHorario[] = lista.map((h) => ({
          tiempo: this.aTiempo(h.hora, h.minuto),
        }));
        this.horarios.set(nuevos);
        this.horariosOriginal.set(
          nuevos.map((f) => ({ tiempo: f.tiempo ? new Date(f.tiempo) : null })),
        );
        this.toast.add({
          severity: 'success',
          summary: 'Horarios guardados',
          detail: nuevos.length === 0
            ? 'Sin horarios — la sync automática queda deshabilitada.'
            : `${nuevos.length} horario${nuevos.length === 1 ? '' : 's'} programado${nuevos.length === 1 ? '' : 's'}.`,
          life: 3000,
        });
      },
      error: (err) => {
        this.guardandoHorarios.set(false);
        toastError(this.toast, 'Guardar horarios', err, 'No se pudieron guardar los horarios');
      },
    });
  }

  // ============================================================
  // Pickit externo — métodos
  // ============================================================

  private cargarPickit(): void {
    this.cargandoPickit.set(true);
    this.api.obtenerPickitConfig().subscribe({
      next: (cfg) => {
        this.cargandoPickit.set(false);
        this.pickitConfig.set({ ...cfg });
        this.pickitConfigOriginal.set({ ...cfg });
      },
      error: (err) => {
        this.cargandoPickit.set(false);
        toastError(this.toast, 'Pickit externo', err, 'No se pudo cargar la config');
      },
    });
  }

  /** Cualquier cambio de un campo individual actualiza la signal completa
   *  (se preserva la inmutabilidad para que `hayCambiosPickit` reaccione). */
  actualizarPickit<K extends keyof PickitConfig>(campo: K, valor: PickitConfig[K]): void {
    this.pickitConfig.set({ ...this.pickitConfig(), [campo]: valor });
  }

  descartarCambiosPickit(): void {
    this.pickitConfig.set({ ...this.pickitConfigOriginal() });
  }

  guardarPickit(): void {
    const cfg = this.pickitConfig();
    if (cfg.enabled) {
      const faltantes: string[] = [];
      if (!cfg.jarPath.trim()) faltantes.push('jar');
      if (!cfg.stockFile.trim()) faltantes.push('stock');
      if (!cfg.combosFile.trim()) faltantes.push('combos');
      if (!cfg.outputDir.trim()) faltantes.push('carpeta de salida');
      if (faltantes.length > 0) {
        this.toast.add({
          severity: 'warn',
          summary: 'Faltan datos',
          detail: `Para habilitar el pickit hay que completar: ${faltantes.join(', ')}.`,
          life: 4000,
        });
        return;
      }
    }
    this.guardandoPickit.set(true);
    this.api.actualizarPickitConfig(cfg).subscribe({
      next: (res) => {
        this.guardandoPickit.set(false);
        this.pickitConfig.set({ ...res });
        this.pickitConfigOriginal.set({ ...res });
        this.toast.add({
          severity: 'success',
          summary: 'Pickit externo guardado',
          detail: res.enabled
            ? 'Se va a generar automáticamente tras cada pedido OK.'
            : 'Generación deshabilitada — solo manual desde /pedidos.',
          life: 3000,
        });
      },
      error: (err) => {
        this.guardandoPickit.set(false);
        toastError(this.toast, 'Pickit externo', err, 'No se pudo guardar la config');
      },
    });
  }


  // ============================================================
  // Usuarios — métodos
  // ============================================================

  private cargarUsuarios(): void {
    this.cargandoUsuarios.set(true);
    this.auth.listarUsuarios().subscribe({
      next: (lista) => {
        this.cargandoUsuarios.set(false);
        this.usuarios.set(lista);
      },
      error: (err) => {
        this.cargandoUsuarios.set(false);
        toastError(this.toast, 'Usuarios', err, 'No se pudieron cargar los usuarios');
      },
    });
  }

  abrirDialogCrearUsuario(): void {
    this.modoEdicionUsuario.set('crear');
    this.usuarioEditar.set(null);
    this.formUsername.set('');
    this.formPassword.set('');
    this.formNombre.set('');
    this.formActivo.set(true);
    this.mostrarFormPassword.set(false);
    this.mostrarDialogUsuario.set(true);
  }

  abrirDialogEditarUsuario(u: Usuario): void {
    this.modoEdicionUsuario.set('editar');
    this.usuarioEditar.set(u);
    this.formUsername.set(u.username);
    this.formPassword.set('');
    this.formNombre.set(u.nombre ?? '');
    this.formActivo.set(u.activo);
    this.mostrarDialogUsuario.set(true);
  }

  guardarUsuario(): void {
    const username = this.formUsername().trim();
    const nombre = this.formNombre().trim();
    const activo = this.formActivo();

    if (this.modoEdicionUsuario() === 'crear') {
      const password = this.formPassword();
      if (!username || !password) {
        this.toast.add({
          severity: 'warn',
          summary: 'Datos incompletos',
          detail: 'Cargá username y password.',
          life: 3000,
        });
        return;
      }
      this.guardandoUsuario.set(true);
      this.auth.crearUsuario({ username, password, nombre, activo }).subscribe({
        next: () => {
          this.guardandoUsuario.set(false);
          this.mostrarDialogUsuario.set(false);
          this.cargarUsuarios();
          this.toast.add({
            severity: 'success',
            summary: 'Usuario creado',
            detail: `${username} ya puede iniciar sesión.`,
            life: 3000,
          });
        },
        error: (err) => {
          this.guardandoUsuario.set(false);
          toastError(this.toast, 'Crear usuario', err, 'No se pudo crear el usuario');
        },
      });
    } else {
      const u = this.usuarioEditar();
      if (!u) return;
      const password = this.formPassword();
      // Validación: si pidió cambiar password, mínimo 6 chars.
      if (password.length > 0 && password.length < 6) {
        this.toast.add({
          severity: 'warn',
          summary: 'Contraseña inválida',
          detail: 'Mínimo 6 caracteres.',
          life: 4000,
        });
        return;
      }
      this.guardandoUsuario.set(true);
      this.auth.actualizarUsuario(u.id, { nombre, activo }).subscribe({
        next: () => {
          // Si el operador cargó una contraseña nueva, hago un reset extra.
          // Si no, terminamos acá.
          if (password.length === 0) {
            this.finalizarEdicion(u.username, false);
            return;
          }
          this.auth.resetearPassword(u.id, password).subscribe({
            next: () => this.finalizarEdicion(u.username, true),
            error: (err) => {
              this.guardandoUsuario.set(false);
              toastError(this.toast, 'Cambiar password', err,
                'Datos guardados, pero no se pudo cambiar la contraseña');
            },
          });
        },
        error: (err) => {
          this.guardandoUsuario.set(false);
          toastError(this.toast, 'Actualizar usuario', err, 'No se pudo actualizar el usuario');
        },
      });
    }
  }

  private finalizarEdicion(username: string, passwordCambiado: boolean): void {
    this.guardandoUsuario.set(false);
    this.mostrarDialogUsuario.set(false);
    this.cargarUsuarios();
    this.toast.add({
      severity: 'success',
      summary: 'Usuario actualizado',
      detail: passwordCambiado
        ? `Cambios guardados para ${username}, incluida la nueva contraseña.`
        : `Cambios guardados para ${username}.`,
      life: 3000,
    });
  }

  eliminarUsuario(u: Usuario): void {
    this.confirmationService.confirm({
      header: 'Eliminar usuario',
      message: `¿Eliminar al usuario "${u.username}"? Esta acción no se puede deshacer.`,
      icon: 'pi pi-exclamation-triangle',
      acceptButtonProps: {
        label: 'Eliminar',
        icon: 'pi pi-trash',
        severity: 'danger',
      },
      rejectButtonProps: {
        label: 'Cancelar',
        severity: 'secondary',
        outlined: true,
      },
      accept: () => {
        this.auth.eliminarUsuario(u.id).subscribe({
          next: () => {
            this.cargarUsuarios();
            this.toast.add({
              severity: 'success',
              summary: 'Usuario eliminado',
              detail: u.username,
              life: 3000,
            });
          },
          error: (err) => toastError(this.toast, 'Eliminar usuario', err, 'No se pudo eliminar'),
        });
      },
    });
  }

  trackByUsuarioId = (_: number, u: Usuario) => u.id;
  trackByIndex = (i: number) => i;

  // ============================================================
  // Rubros que cotizan sin IVA — métodos
  // ============================================================

  private cargarRubrosSinIva(): void {
    this.cargandoRubrosSinIva.set(true);
    this.api.listarRubrosProductos().subscribe({
      next: (lista) => this.rubrosDisponibles.set(lista),
      error: () => {
        /* sin lista, el multiselect queda solo con los rubros ya seleccionados */
      },
    });
    this.api.obtenerRubrosSinIva().subscribe({
      next: (lista) => {
        this.rubrosSinIvaSeleccionados.set(lista);
        this.cargandoRubrosSinIva.set(false);
      },
      error: (err) => {
        this.cargandoRubrosSinIva.set(false);
        toastError(this.toast, 'Rubros sin IVA', err, 'No se pudieron cargar los rubros sin IVA');
      },
    });
  }

  guardarRubrosSinIva(): void {
    this.guardandoRubrosSinIva.set(true);
    this.api.guardarRubrosSinIva(this.rubrosSinIvaSeleccionados()).subscribe({
      next: (lista) => {
        this.rubrosSinIvaSeleccionados.set(lista);
        this.guardandoRubrosSinIva.set(false);
        this.toast.add({
          severity: 'success',
          summary: 'Guardado',
          detail: 'Rubros que cotizan sin IVA actualizados.',
          life: 3000,
        });
      },
      error: (err) => {
        this.guardandoRubrosSinIva.set(false);
        toastError(this.toast, 'Rubros sin IVA', err, 'No se pudieron guardar los rubros sin IVA');
      },
    });
  }

  // ============================================================
  // Formas de pago — métodos
  // ============================================================

  private cargarFormasPago(): void {
    this.cargandoFormasPago.set(true);
    this.api.listarFormasPagoConfig().subscribe({
      next: (lista) => {
        this.cargandoFormasPago.set(false);
        this.formasPago.set(lista);
      },
      error: (err) => {
        this.cargandoFormasPago.set(false);
        toastError(this.toast, 'Formas de pago', err, 'No se pudieron cargar las formas de pago');
      },
    });
  }

  abrirDialogCrearForma(): void {
    this.modoEdicionForma.set('crear');
    this.formaEditar.set(null);
    this.formNombrePago.set('');
    this.formRecargo.set(0);
    this.formCuotas.set(1);
    this.formAplicaIva.set(true);
    this.formActivoPago.set(true);
    this.formPrecioReferencia.set(false);
    this.formRecargoMaquinaria.set(null);
    this.formAplicaIvaMaquinaria.set(false);
    const maxOrden = this.formasPago().reduce((max, f) => Math.max(max, f.orden ?? 0), -1);
    this.formOrden.set(maxOrden + 1);
    this.mostrarDialogForma.set(true);
  }

  abrirDialogEditarForma(f: FormaPago): void {
    this.modoEdicionForma.set('editar');
    this.formaEditar.set(f);
    this.formNombrePago.set(f.nombre);
    this.formRecargo.set(f.recargoPorcentaje);
    this.formCuotas.set(f.cantidadCuotas);
    this.formAplicaIva.set(f.aplicaIva ?? true);
    this.formActivoPago.set(f.activo);
    this.formPrecioReferencia.set(f.precioReferencia ?? false);
    this.formRecargoMaquinaria.set(f.recargoPorcentajeMaquinaria ?? null);
    this.formAplicaIvaMaquinaria.set(f.aplicaIvaMaquinaria ?? false);
    this.formOrden.set(f.orden);
    this.mostrarDialogForma.set(true);
  }

  guardarForma(): void {
    const nombre = this.formNombrePago().trim();
    const recargo = this.formRecargo() ?? 0;
    const cuotas = this.formCuotas() ?? 1;
    const activo = this.formActivoPago();
    const orden = this.formOrden() ?? 0;

    if (!nombre) {
      this.toast.add({
        severity: 'warn',
        summary: 'Datos incompletos',
        detail: 'Cargá un nombre para la forma de pago.',
        life: 3000,
      });
      return;
    }
    if (cuotas < 1) {
      this.toast.add({
        severity: 'warn',
        summary: 'Cuotas inválidas',
        detail: 'Mínimo 1 cuota.',
        life: 3000,
      });
      return;
    }

    this.guardandoForma.set(true);
    const payload: Partial<FormaPago> = {
      nombre,
      recargoPorcentaje: recargo,
      cantidadCuotas: cuotas,
      aplicaIva: this.formAplicaIva(),
      recargoPorcentajeMaquinaria: this.formRecargoMaquinaria(),
      aplicaIvaMaquinaria: this.formAplicaIvaMaquinaria(),
      activo,
      orden,
      precioReferencia: this.formPrecioReferencia(),
    };
    const obs = this.modoEdicionForma() === 'crear'
      ? this.api.crearFormaPago(payload)
      : this.api.actualizarFormaPago(this.formaEditar()!.id, payload);

    obs.subscribe({
      next: () => {
        this.guardandoForma.set(false);
        this.mostrarDialogForma.set(false);
        this.cargarFormasPago();
        this.toast.add({
          severity: 'success',
          summary: this.modoEdicionForma() === 'crear' ? 'Forma de pago creada' : 'Forma de pago actualizada',
          detail: nombre,
          life: 3000,
        });
      },
      error: (err) => {
        this.guardandoForma.set(false);
        toastError(this.toast, 'Forma de pago', err, 'No se pudo guardar la forma de pago');
      },
    });
  }

  eliminarForma(f: FormaPago): void {
    this.confirmationService.confirm({
      header: 'Desactivar forma de pago',
      message: `¿Desactivar "${f.nombre}"? Deja de aparecer en el selector del operador. Los pedidos viejos que la usaron preservan sus datos.`,
      icon: 'pi pi-exclamation-triangle',
      acceptButtonProps: {
        label: 'Desactivar',
        icon: 'pi pi-ban',
        severity: 'danger',
      },
      rejectButtonProps: {
        label: 'Cancelar',
        severity: 'secondary',
        outlined: true,
      },
      accept: () => {
        this.api.eliminarFormaPago(f.id).subscribe({
          next: () => {
            this.cargarFormasPago();
            this.toast.add({
              severity: 'success',
              summary: 'Forma de pago desactivada',
              detail: f.nombre,
              life: 3000,
            });
          },
          error: (err) => toastError(this.toast, 'Desactivar forma de pago', err, 'No se pudo desactivar'),
        });
      },
    });
  }

  /** Borrado definitivo (hard delete) con confirmación. Disponible para cualquier
   *  forma; los pedidos históricos preservan su snapshot. */
  eliminarFormaDefinitivo(f: FormaPago): void {
    this.confirmationService.confirm({
      header: 'Eliminar definitivamente',
      message: `¿Eliminar para siempre la forma de pago "${f.nombre}"? Esta acción no se puede deshacer. Los pedidos que la usaron conservan sus datos.`,
      icon: 'pi pi-trash',
      acceptButtonProps: {
        label: 'Eliminar',
        icon: 'pi pi-trash',
        severity: 'danger',
      },
      rejectButtonProps: {
        label: 'Cancelar',
        severity: 'secondary',
        outlined: true,
      },
      accept: () => {
        this.api.eliminarFormaPagoDefinitivo(f.id).subscribe({
          next: () => {
            this.cargarFormasPago();
            this.toast.add({
              severity: 'success',
              summary: 'Forma de pago eliminada',
              detail: f.nombre,
              life: 3000,
            });
          },
          error: (err) => toastError(this.toast, 'Eliminar forma de pago', err, 'No se pudo eliminar'),
        });
      },
    });
  }

  trackByFormaPagoId = (_: number, f: FormaPago) => f.id;

  // ============================================================
  // Notificaciones auto — métodos
  // ============================================================

  private cargarNotificacionesAuto(): void {
    this.cargandoNotificacionesAuto.set(true);
    this.api.obtenerNotificacionesAuto().subscribe({
      next: (cfg) => {
        this.cargandoNotificacionesAuto.set(false);
        this.notificacionesAuto.set(cfg);
      },
      error: (err) => {
        this.cargandoNotificacionesAuto.set(false);
        toastError(this.toast, 'Notificaciones', err, 'No se pudo cargar la config de notificaciones');
      },
    });
  }

  /** Auto-save al togglear — los 2 booleans son atómicos, no necesitan
   *  flujo de "discard changes". El toast confirma cada cambio. */
  toggleNotificacionAuto(campo: 'emailAutoPedido' | 'whatsappAutoPedido', valor: boolean): void {
    const actual = this.notificacionesAuto();
    if (!actual) return; // todavía no cargó del backend
    const nueva: NotificacionesAutoConfig = { ...actual, [campo]: valor };
    // Update optimista — la UI responde instantáneo. Si el PUT falla, revertimos.
    this.notificacionesAuto.set(nueva);
    this.guardandoNotificacionesAuto.set(true);
    this.api.guardarNotificacionesAuto(nueva).subscribe({
      next: (cfg) => {
        this.guardandoNotificacionesAuto.set(false);
        this.notificacionesAuto.set(cfg);
        const canal = campo === 'emailAutoPedido' ? 'Email' : 'WhatsApp';
        this.toast.add({
          severity: 'success',
          summary: `${canal} automático ${valor ? 'activado' : 'desactivado'}`,
          detail: valor
            ? 'Se va a mandar tras cada pedido OK.'
            : 'No se manda automático. El botón manual sigue disponible.',
          life: 3000,
        });
      },
      error: (err) => {
        this.guardandoNotificacionesAuto.set(false);
        // Revertir optimistic.
        this.notificacionesAuto.set(actual);
        toastError(this.toast, 'Notificaciones', err, 'No se pudo guardar el cambio');
      },
    });
  }
}

/**
 * 5 esquemas de color cíclicos para los escalones de descuento, en el mismo
 * orden que el showroom-page (ámbar → esmeralda → cielo → violeta → rosa).
 * Solo borde + fondo + pill: en /configuracion los escalones son cards
 * compactas, no necesitan la paleta extendida de la pantalla principal.
 */
const ESCALON_COLOR_SCHEMES = [
  {
    border: 'border-amber-300 dark:border-amber-700',
    bg: 'bg-amber-50 dark:bg-amber-950/30',
    pill: 'bg-amber-500',
  },
  {
    border: 'border-emerald-400 dark:border-emerald-700',
    bg: 'bg-emerald-50 dark:bg-emerald-950/30',
    pill: 'bg-emerald-600',
  },
  {
    border: 'border-sky-400 dark:border-sky-700',
    bg: 'bg-sky-50 dark:bg-sky-950/30',
    pill: 'bg-sky-600',
  },
  {
    border: 'border-violet-400 dark:border-violet-700',
    bg: 'bg-violet-50 dark:bg-violet-950/30',
    pill: 'bg-violet-600',
  },
  {
    border: 'border-rose-400 dark:border-rose-700',
    bg: 'bg-rose-50 dark:bg-rose-950/30',
    pill: 'bg-rose-600',
  },
] as const;
