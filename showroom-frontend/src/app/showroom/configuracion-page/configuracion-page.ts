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
import { CheckboxModule } from 'primeng/checkbox';
import { DatePickerModule } from 'primeng/datepicker';
import { DialogModule } from 'primeng/dialog';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { TableModule } from 'primeng/table';
import { ToolbarModule } from 'primeng/toolbar';
import { TooltipModule } from 'primeng/tooltip';
import { AuthService, Usuario } from '../../auth/auth.service';
import { EscalaDescuento, HorarioSync } from '../models';
import { ShowroomService } from '../showroom.service';
import { toastError } from '../toast.utils';

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
    TableModule,
    ToolbarModule,
    TooltipModule,
  ],
  templateUrl: './configuracion-page.html',
  styleUrl: './configuracion-page.scss',
})
export class ConfiguracionPage {
  private readonly api = inject(ShowroomService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(MessageService);

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
  // Email destinatario del picking
  // ============================================================
  readonly cargandoEmail = signal(false);
  readonly guardandoEmail = signal(false);
  readonly emailPicking = signal('');
  /** Snapshot del email como vino del backend — para detectar cambios y deshacer. */
  private readonly emailPickingOriginal = signal('');

  readonly hayCambiosEmail = computed(
    () => this.emailPicking().trim() !== this.emailPickingOriginal().trim(),
  );

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


  constructor() {
    this.cargar();
    this.cargarHorarios();
    this.cargarEmail();
    this.cargarUsuarios();
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
  // Email — métodos
  // ============================================================

  private cargarEmail(): void {
    this.cargandoEmail.set(true);
    this.api.obtenerEmailPicking().subscribe({
      next: (res) => {
        this.cargandoEmail.set(false);
        this.emailPicking.set(res.email ?? '');
        this.emailPickingOriginal.set(res.email ?? '');
      },
      error: (err) => {
        this.cargandoEmail.set(false);
        toastError(this.toast, 'Email picking', err, 'No se pudo cargar el email');
      },
    });
  }

  descartarCambiosEmail(): void {
    this.emailPicking.set(this.emailPickingOriginal());
  }

  guardarEmail(): void {
    const valor = this.emailPicking().trim();
    // El backend hace la validación canónica; acá solo descartamos el caso
    // "claramente roto" para feedback inmediato (sin pegarle a la BD).
    if (valor.length > 0) {
      const partes = valor.split(/\s*,\s*/);
      const formato = /^[^@\s,]+@[^@\s,]+\.[^@\s,]+$/;
      const invalido = partes.find((p) => !formato.test(p));
      if (invalido) {
        this.toast.add({
          severity: 'warn',
          summary: 'Email inválido',
          detail: `"${invalido}" no parece un email. Usá el formato nombre@dominio.com.`,
          life: 4000,
        });
        return;
      }
    }
    this.guardandoEmail.set(true);
    this.api.actualizarEmailPicking(valor).subscribe({
      next: (res) => {
        this.guardandoEmail.set(false);
        const efectivo = res.email ?? '';
        this.emailPicking.set(efectivo);
        this.emailPickingOriginal.set(efectivo);
        this.toast.add({
          severity: 'success',
          summary: 'Email guardado',
          detail: efectivo
            ? `Picking se va a enviar a: ${efectivo}`
            : 'Email vacío — el envío queda deshabilitado.',
          life: 3000,
        });
      },
      error: (err) => {
        this.guardandoEmail.set(false);
        toastError(this.toast, 'Email picking', err, 'No se pudo guardar el email');
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
    if (!confirm(`¿Eliminar al usuario "${u.username}"?`)) return;
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
  }

  trackByUsuarioId = (_: number, u: Usuario) => u.id;
  trackByIndex = (i: number) => i;
}
