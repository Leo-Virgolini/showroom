import {
  ChangeDetectionStrategy,
  Component,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { MessageService } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { InputTextModule } from 'primeng/inputtext';
import { ToastModule } from 'primeng/toast';
import { AuthService } from '../auth.service';

/**
 * Login screen del showroom. Sin auto-completado de credenciales (es la PC
 * compartida del showroom — mejor que el operador tipee). Después del login
 * exitoso, redirige a la URL que pidió originalmente (queryParam {@code redirect})
 * o al inicio.
 */
@Component({
  selector: 'app-login-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    FormsModule,
    ButtonModule,
    CardModule,
    IconFieldModule,
    InputIconModule,
    InputTextModule,
    ToastModule,
  ],
  templateUrl: './login-page.html',
  styleUrl: './login-page.scss',
  providers: [MessageService],
})
export class LoginPage {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly toast = inject(MessageService);

  readonly username = signal('');
  readonly password = signal('');
  readonly mostrarPassword = signal(false);
  readonly cargando = signal(false);

  submit(): void {
    const u = this.username().trim();
    const p = this.password();
    if (!u || !p) {
      this.toast.add({
        severity: 'warn',
        summary: 'Faltan datos',
        detail: 'Cargá usuario y contraseña.',
        life: 3000,
      });
      return;
    }
    this.cargando.set(true);
    this.auth.login(u, p).subscribe({
      next: () => {
        this.cargando.set(false);
        const redirect = this.route.snapshot.queryParamMap.get('redirect') || '/';
        this.router.navigateByUrl(redirect);
      },
      error: (err) => {
        this.cargando.set(false);
        if (err.status === 401) {
          this.toast.add({
            severity: 'error',
            summary: 'Credenciales inválidas',
            detail: 'Usuario o contraseña incorrectos.',
            life: 4000,
          });
        } else if (err.status === 403) {
          this.toast.add({
            severity: 'error',
            summary: 'Usuario deshabilitado',
            detail: 'Hablá con el admin.',
            life: 4000,
          });
        } else {
          this.toast.add({
            severity: 'error',
            summary: 'Error',
            detail: err.error?.error || 'No se pudo conectar al servidor.',
            life: 4000,
          });
        }
      },
    });
  }
}
