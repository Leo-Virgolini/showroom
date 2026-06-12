import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterModule } from '@angular/router';
import { MenuItem } from 'primeng/api';
import { MenubarModule } from 'primeng/menubar';

/**
 * Menú de navegación principal de la app, basado en {@code p-menubar}
 * (categorías horizontales con dropdowns). Reemplazó al viejo {@code MoreMenu}
 * (popup "Más"): agrupa todas las pantallas en seis categorías
 * (PEDIDOS, PRESUPUESTOS, CLIENTES, PRODUCTOS, HERRAMIENTAS, CONFIGURACIÓN),
 * cada una con su ícono y color para que el operador las distinga de un vistazo.
 *
 * <p>Se inserta en {@code app-top-actions}, así aparece en el toolbar de todas
 * las páginas autenticadas. {@code p-menubar} colapsa a hamburguesa en pantallas
 * chicas (útil para el uso táctil del showroom).
 *
 * <p>Los botones "Nuevo Cliente" (sesión) y "QR" (visor) NO viven acá: son
 * context-específicos y se quedan en los toolbars de showroom y presupuestos.
 *
 * <p>El color de cada ítem (categoría y destino) se aplica vía {@code styleClass}
 * del {@link MenuItem} — la API soportada del modelo — y se estiliza en
 * {@code styles.scss} bajo {@code .kt-mainmenu}.
 */
@Component({
  selector: 'app-main-menu',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterModule, MenubarModule],
  template: `
    <p-menubar [model]="items" class="kt-mainmenu" />
  `,
})
export class MainMenu {
  /** Estructura del menú — fuente única para toda la app. Las categorías de
   *  primer nivel llevan su color/ícono; los sub-ítems conservan el color de la
   *  pantalla destino (mismo criterio que tenía el MoreMenu). */
  readonly items: MenuItem[] = [
    {
      // "Atenciones" = el showroom (atención al cliente, escaneo de muestras).
      // Color índigo: distintivo respecto del ámbar de Presupuestos. El showroom
      // conserva sus acentos naranja de marca (logo, sync, highlights de scan).
      label: 'Atenciones', icon: 'pi pi-comments', styleClass: 'kt-cat-indigo',
      items: [
        { label: 'Nueva atención', icon: 'pi pi-plus-circle',
          styleClass: 'kt-item-indigo', routerLink: '/' },
        { label: 'Historial de Atenciones', icon: 'pi pi-history',
          styleClass: 'kt-item-indigo', routerLink: '/historial' },
      ],
    },
    {
      label: 'Presupuestos', icon: 'pi pi-file-edit', styleClass: 'kt-cat-amber',
      items: [
        { label: 'Nuevo Presupuesto', icon: 'pi pi-plus-circle',
          styleClass: 'kt-item-amber', routerLink: '/presupuestos' },
        { label: 'Historial de Presupuestos', icon: 'pi pi-history',
          styleClass: 'kt-item-amber', routerLink: '/presupuestos/historial' },
      ],
    },
    {
      label: 'Historial de Pedidos', icon: 'pi pi-history', styleClass: 'kt-cat-sky',
      routerLink: '/pedidos',
    },
    {
      label: 'Clientes', icon: 'pi pi-users', styleClass: 'kt-cat-rose',
      routerLink: '/clientes',
    },
    {
      label: 'Productos', icon: 'pi pi-box', styleClass: 'kt-cat-emerald',
      routerLink: '/productos',
    },
    {
      label: 'Herramientas', icon: 'pi pi-wrench', styleClass: 'kt-cat-violet',
      items: [
        { label: 'Imprimir QR', icon: 'pi pi-qrcode',
          styleClass: 'kt-item-violet', routerLink: '/etiquetas' },
        { label: 'Cotizador', icon: 'pi pi-calculator',
          styleClass: 'kt-item-violet', routerLink: '/cotizador' },
        { label: 'Historial de cotizaciones', icon: 'pi pi-history',
          styleClass: 'kt-item-violet', routerLink: '/cotizador/historial' },
      ],
    },
    {
      label: 'Configuración', icon: 'pi pi-cog', styleClass: 'kt-cat-slate',
      routerLink: '/configuracion',
    },
  ];
}
