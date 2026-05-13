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
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { MessageService } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { ProgressBarModule } from 'primeng/progressbar';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { ToastModule } from 'primeng/toast';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { TooltipModule } from 'primeng/tooltip';
import { filter, map, startWith } from 'rxjs/operators';
import { AuthService } from './auth/auth.service';
import { BackendStatusService } from './showroom/backend-status.service';
import { PwaInstallService } from './showroom/pwa-install.service';
import { ShowroomService } from './showroom/showroom.service';
import { SyncStateService } from './showroom/sync-state.service';
import { ClientIdService } from './showroom/client-id.service';
import { toastError } from './showroom/toast.utils';

@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, RouterOutlet, ButtonModule, ProgressBarModule, ProgressSpinnerModule, ToastModule, TooltipModule],
  providers: [MessageService],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  protected readonly syncState = inject(SyncStateService);
  protected readonly backendStatus = inject(BackendStatusService);
  protected readonly pwaInstall = inject(PwaInstallService);
  protected readonly auth = inject(AuthService);
  private readonly api = inject(ShowroomService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly router = inject(Router);
  private readonly clientIdService = inject(ClientIdService);

  /** True cuando la ruta activa es /visor — la pantalla del visor del cliente
   *  no debe mostrar overlays operativos (banner de sync, botón de instalar PWA)
   *  porque es read-only y debería verse limpia desde el celular. */
  protected readonly esVistaVisor = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => e.urlAfterRedirects.startsWith('/visor')),
      startWith(this.router.url.startsWith('/visor')),
    ),
    { initialValue: this.router.url.startsWith('/visor') },
  );

  /** True mientras la request de cancelar el sync está en vuelo — el botón se
   *  deshabilita y muestra "Cancelando…" hasta que el evento SSE CANCELLED
   *  llegue (el sync va a esconder el banner solo). */
  readonly cancelandoSync = signal(false);

  cancelarSync(): void {
    if (this.cancelandoSync()) return;
    this.cancelandoSync.set(true);
    this.api.cancelarSync().subscribe({
      next: () => {
        this.toast.add({
          severity: 'info',
          summary: 'Cancelando sincronización',
          detail: 'El sync va a abortar entre las próximas páginas (~7s).',
          life: 4000,
        });
      },
      error: (err) => {
        this.cancelandoSync.set(false);
        toastError(this.toast, 'Cancelar sync', err, 'No se pudo cancelar el sync');
      },
    });
  }

  /** Tick cada segundo para refrescar el contador "lleva XX:XX" en el banner. */
  private readonly tick = signal(Date.now());

  readonly transcurrido = computed(() => {
    this.tick();
    const iso = this.syncState.syncIniciadoAt();
    if (!iso) return '';
    const elapsed = Math.max(0, Date.now() - new Date(iso).getTime());
    const min = Math.floor(elapsed / 60000);
    const seg = Math.floor((elapsed % 60000) / 1000);
    return `${String(min).padStart(2, '0')}:${String(seg).padStart(2, '0')}`;
  });

  /**
   * True si el último evento RATE_LIMITED llegó hace menos de 90s — pasado ese
   * tiempo asumimos que DUX se desbloqueó y volvemos al banner verde, aunque
   * no hayamos recibido un evento explícito de "rate limit cleared" (DUX no
   * lo emite, solo manda 200s en el stream de requests del retry handler).
   */
  readonly estaRateLimited = computed(() => {
    this.tick();
    const e = this.syncState.ultimoEvento();
    if (e?.estado !== 'RATE_LIMITED') return false;
    const haceMs = Date.now() - new Date(e.iniciadoAt).getTime();
    return haceMs < 90_000;
  });

  /** Mensaje que se muestra al lado del icono ámbar cuando hay rate limit. */
  readonly rateLimitTexto = computed(() => {
    const e = this.syncState.ultimoEvento();
    if (e?.estado !== 'RATE_LIMITED') return '';
    const seg = e.esperandoMs ? Math.round(e.esperandoMs / 1000) : 0;
    return `DUX saturado (429), esperando ${seg}s — intento ${e.intento ?? '?'}`;
  });

  /** Clases del banner según estado: verde para sync normal, ámbar para rate limit. */
  readonly bannerClass = computed(() =>
    this.estaRateLimited()
      ? 'from-amber-500 to-amber-600'
      : 'from-emerald-500 to-emerald-600',
  );

  /**
   * Progreso real del sync 0-100 cuando el backend reporta `items/total` por página.
   * Si todavía no llegó ningún PROGRESS, cae al estimado por tiempo (~15 min para ~5800).
   */
  readonly progresoEstimado = computed(() => {
    const actual = this.syncState.progresoActual();
    const total = this.syncState.progresoTotal();
    if (actual != null && total && total > 0) {
      return Math.min(100, Math.round((actual / total) * 100));
    }
    // Fallback al estimado por tiempo (15 min) solo si todavía no llegó ningún PROGRESS.
    this.tick();
    const iso = this.syncState.syncIniciadoAt();
    if (!iso) return 0;
    const elapsed = Date.now() - new Date(iso).getTime();
    return Math.min(99, Math.round((elapsed / (15 * 60_000)) * 100));
  });

  /** Texto del banner: "X / Y productos" cuando hay progreso real, "X productos"
   *  si solo tenemos el contador parcial, o "Iniciando…" antes del primer evento. */
  readonly progresoTexto = computed(() => {
    const actual = this.syncState.progresoActual();
    const total = this.syncState.progresoTotal();
    if (actual != null && total != null && total > 0) {
      return `${actual.toLocaleString('es-AR')} / ${total.toLocaleString('es-AR')} productos`;
    }
    if (actual != null) {
      return `${actual.toLocaleString('es-AR')} productos`;
    }
    return 'Iniciando…';
  });

  constructor() {
    // Resolver la sesión inicial al arrancar la app — el guard también lo
    // hace pero precargarlo acá evita el flicker de "no logueado → logueado"
    // cuando el operador abre la app con una sesión ya activa.
    this.auth.cargarSesionInicial().subscribe();

    // Tick por segundo solo cuando el banner es visible — sin sync, no hay
    // necesidad de invalidar `transcurrido()` ni `progresoEstimado()` cada
    // segundo (el árbol del banner ni siquiera está montado).
    let interval: ReturnType<typeof setInterval> | null = null;
    effect(() => {
      const necesitaTick = this.syncState.syncEnCurso() || this.estaRateLimited();
      if (necesitaTick && interval == null) {
        interval = setInterval(() => this.tick.set(Date.now()), 1000);
      } else if (!necesitaTick && interval != null) {
        clearInterval(interval);
        interval = null;
      }
    });
    this.destroyRef.onDestroy(() => {
      if (interval != null) clearInterval(interval);
    });

    // Toasts globales basados en eventos SSE — todos los clientes reaccionan al mismo
    // evento sin importar quién disparó el sync. El visor es read-only para el
    // cliente: no se muestran toasts operativos ahí.
    effect(() => {
      const e = this.syncState.ultimoEvento();
      if (!e || this.esVistaVisor()) return;
      switch (e.estado) {
        case 'COMPLETED':
          this.cancelandoSync.set(false);
          this.toast.add({
            severity: 'success',
            summary: 'Sincronización completada',
            detail:
              e.items != null
                ? `${e.items} producto${e.items === 1 ? '' : 's'} actualizado${e.items === 1 ? '' : 's'}.`
                : 'El catálogo está actualizado.',
            life: 5000,
          });
          break;
        case 'CANCELLED':
          this.cancelandoSync.set(false);
          this.toast.add({
            severity: 'warn',
            summary: 'Sincronización cancelada',
            detail:
              e.items != null && e.items > 0
                ? `Se guardaron ${e.items} producto${e.items === 1 ? '' : 's'} antes de abortar.`
                : 'El sync se canceló sin descargar productos.',
            life: 6000,
          });
          break;
        case 'FAILED':
          this.cancelandoSync.set(false);
          this.toast.add({
            severity: 'error',
            summary: 'Sincronización fallida',
            detail: e.mensaje ?? 'El sync falló — revisar logs del backend.',
            life: 8000,
          });
          break;
      }
    });

    // Toast de picking email — el envío es async después del pedido y todos los
    // clientes lo ven (no solo el operador que cargó el pedido). El visor es
    // read-only para el cliente: no se muestran toasts operativos ahí.
    this.backendStatus.pickingEmailEvents$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((e) => {
        if (this.esVistaVisor()) return;
        const ref = e.cuit ? `CUIT ${e.cuit}` : `pedido #${e.pedidoId}`;
        if (e.estado === 'SENT') {
          this.toast.add({
            severity: 'success',
            summary: 'Email de picking enviado',
            detail: `Adjuntos despachados (${ref}).`,
            life: 5000,
          });
        } else {
          this.toast.add({
            severity: 'error',
            summary: 'Falló el envío del email de picking',
            detail: e.error
              ? `${ref}: ${e.error}`
              : `No se pudo enviar (${ref}). Revisar logs del backend.`,
            life: 10000,
          });
        }
      });

    // Toast del pickit externo (programa pickit-y-etiquetas). Igual que el
    // email: lo ven todos los clientes operativos, no el visor. La AUTO-DESCARGA
    // del .xlsx solo la dispara la pestaña que originó el pedido (matcheada via
    // X-Client-Id); las demás muestran el toast informativo sin descargar.
    this.backendStatus.pickitExternoEvents$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((e) => {
        if (this.esVistaVisor()) return;
        const ref = `pedido #${e.pedidoId}`;
        const esOrigen = e.clientId != null && e.clientId === this.clientIdService.get();
        if (e.estado === 'GENERATED' && e.outputPath) {
          this.toast.add({
            severity: 'success',
            summary: 'Pickit externo generado',
            detail: esOrigen
              ? `${ref}: descargando ${this.nombreArchivo(e.outputPath)}…`
              : `Generado para ${ref}.`,
            life: 5000,
          });
          if (esOrigen) {
            this.descargarPickitExterno(e.outputPath);
          }
        } else if (e.estado === 'GENERATED') {
          this.toast.add({
            severity: 'success',
            summary: 'Pickit externo generado',
            detail: `Generado para ${ref}.`,
            life: 5000,
          });
        } else {
          this.toast.add({
            severity: 'error',
            summary: 'Falló el pickit externo',
            detail: e.error
              ? `${ref}: ${e.error}`
              : `No se pudo generar (${ref}). Revisar config y logs.`,
            life: 10000,
          });
        }
      });
  }

  /** Extrae el nombre del archivo de un path (separadores Unix o Windows). */
  private nombreArchivo(path: string): string {
    const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
    return i >= 0 ? path.substring(i + 1) : path;
  }

  /** Pide el .xlsx al backend y dispara la descarga del browser sin abrir tab. */
  private descargarPickitExterno(path: string): void {
    this.api.descargarPickitExternoArchivo(path).subscribe({
      next: (resp) => {
        const blob = resp.body;
        if (!blob) return;
        const nombre = this.nombreArchivo(path);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = nombre;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      },
      error: (err) => {
        toastError(this.toast, 'Descarga pickit', err, 'No se pudo descargar el pickit generado.');
      },
    });
  }
}
