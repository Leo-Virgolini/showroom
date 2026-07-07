import { Injectable, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Observable, catchError, of, tap } from 'rxjs';

export interface UsuarioActual {
  id: number;
  username: string;
  nombre: string | null;
}

export interface Usuario {
  id: number;
  username: string;
  nombre: string | null;
  activo: boolean;
}

/**
 * Cliente del API de autenticación + estado del usuario logueado.
 *
 * <p>Usa cookie de sesión (SESSION, de Spring Session) — no manejamos tokens
 * en localStorage.
 * Spring Security hace el resto. El frontend sólo:
 *  - Llama a /api/auth/login con username+password.
 *  - Lee /api/auth/me al iniciar para saber si ya hay sesión.
 *  - Llama a /api/auth/logout para cerrarla.
 *
 * <p>El signal {@code currentUser} es la fuente de verdad — null = no logueado;
 * objeto = sesión activa.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);

  /** Usuario actualmente logueado, o null si no hay sesión. {@code undefined}
   *  hasta que se resuelve la primera llamada a /me. */
  readonly currentUser = signal<UsuarioActual | null | undefined>(undefined);

  /** True mientras estamos resolviendo la sesión inicial — los guards esperan
   *  esto antes de decidir redirigir. */
  readonly resolved = signal(false);

  /**
   * Llamado al iniciar la app para saber si ya hay sesión activa (cookie viva).
   * Si /me devuelve 401, currentUser queda null. Si responde 200, queda con
   * los datos del usuario.
   */
  cargarSesionInicial(): Observable<UsuarioActual | null> {
    return this.http.get<UsuarioActual>('/api/auth/me').pipe(
      tap((u) => {
        this.currentUser.set(u);
        this.resolved.set(true);
      }),
      catchError((err: HttpErrorResponse) => {
        if (err.status === 401) {
          this.currentUser.set(null);
        }
        this.resolved.set(true);
        return of(null);
      }),
    );
  }

  login(username: string, password: string): Observable<UsuarioActual> {
    return this.http
      .post<UsuarioActual>('/api/auth/login', { username, password })
      .pipe(tap((u) => this.currentUser.set(u)));
  }

  logout(): Observable<void> {
    return this.http
      .post<void>('/api/auth/logout', {})
      .pipe(tap(() => this.currentUser.set(null)));
  }


  // ============================================================
  // CRUD de usuarios
  // ============================================================

  listarUsuarios(): Observable<Usuario[]> {
    return this.http.get<Usuario[]>('/api/usuarios');
  }

  crearUsuario(payload: {
    username: string;
    password: string;
    nombre: string;
    activo: boolean;
  }): Observable<Usuario> {
    return this.http.post<Usuario>('/api/usuarios', payload);
  }

  actualizarUsuario(id: number, payload: { nombre: string; activo: boolean }): Observable<Usuario> {
    return this.http.put<Usuario>(`/api/usuarios/${id}`, payload);
  }

  eliminarUsuario(id: number): Observable<void> {
    return this.http.delete<void>(`/api/usuarios/${id}`);
  }

  resetearPassword(id: number, passwordNuevo: string): Observable<void> {
    return this.http.post<void>(`/api/usuarios/${id}/reset-password`, { passwordNuevo });
  }
}
