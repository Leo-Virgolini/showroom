import { ChangeDetectionStrategy, Component, signal, viewChild } from '@angular/core';
import { MenuItem } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { Menu, MenuModule } from 'primeng/menu';
import { TooltipModule } from 'primeng/tooltip';

/**
 * Menú de navegación principal de la app — agrupa accesos a todas las
 * pantallas no-operativas (consultas, herramientas, configuración) en un
 * popup compacto que cabe en cualquier toolbar.
 *
 * <p>Antes vivía inline en {@code showroom-page} y solo aparecía ahí, lo
 * que obligaba al operador a volver al showroom para saltar entre secciones
 * (ej. de {@code /pedidos} a {@code /presupuestos}). Encapsulado como
 * componente standalone se puede insertar en todos los toolbars autenticados
 * — navegación uniforme sin escalas innecesarias.
 *
 * <p>Color del botón: {@code btn-kt-naranja-oscuro} (terracota), del mismo
 * "family" que el naranja brillante del logo KT pero más profundo para no
 * confundirse con el botón "Sincronizar" del showroom-page.
 */
@Component({
  selector: 'app-more-menu',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonModule, MenuModule, TooltipModule],
  template: `
    <p-menu #menuRef [model]="items" [popup]="true" appendTo="body"
      [pt]="{ root: { class: 'kt-menu-extras' } }" />
    <p-button icon="pi pi-bars" [label]="screenLg() ? 'Más' : ''"
      ariaLabel="Más opciones" class="btn-kt-naranja-oscuro"
      (onClick)="menuRef.toggle($event)"
      pTooltip="Presupuestos, pedidos, historial, clientes, productos, etiquetas, configuración"
      tooltipPosition="bottom" />
  `,
})
export class MoreMenu {
  readonly menuRef = viewChild<Menu>('menuRef');

  /** Detección desktop vs mobile para mostrar/ocultar el label del botón.
   *  Coherente con el patrón de otros toolbars (`screenLg` signal local). */
  readonly screenLg = signal(
    typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches,
  );

  /** Estructura del menú — fuente única para toda la app. Cada item lleva
   *  el color de la página destino (mismo color que el bg-{color}-50 del
   *  body de esa página), aplicado tanto al ícono como al texto via
   *  {@code iconClass} y {@code styleClass} respectivamente — así el
   *  operador asocia visualmente "el item amber lleva a la pantalla
   *  amber" sin tener que leer cada label. */
  readonly items: MenuItem[] = [
    { label: 'Herramientas', items: [
      { label: 'Armar presupuesto', icon: 'pi pi-file-edit',
        iconClass: 'text-amber-700', styleClass: 'kt-menu-item-amber',
        routerLink: '/presupuestos' },
      { label: 'Cotizador de financiación', icon: 'pi pi-calculator',
        iconClass: 'text-teal-700', styleClass: 'kt-menu-item-teal',
        routerLink: '/cotizador' },
      { label: 'Imprimir etiquetas QR', icon: 'pi pi-tags',
        iconClass: 'text-violet-700', styleClass: 'kt-menu-item-violet',
        routerLink: '/etiquetas' },
    ]},
    { label: 'Consultas', items: [
      // Historial de pedidos arriba: es el outcome operacional (venta
      // concretada) y lo que el operador consulta con más frecuencia. Mismo
      // prefijo "Historial de…" que el resto de las vistas de consulta.
      { label: 'Historial de pedidos', icon: 'pi pi-receipt',
        iconClass: 'text-sky-700', styleClass: 'kt-menu-item-sky',
        routerLink: '/pedidos' },
      // Los tres "Historial de…" agrupados, mismo prefijo verbal — el ojo los
      // escanea como una sola sub-familia (vistas de auditoría / lookup).
      { label: 'Historial de presupuestos', icon: 'pi pi-file',
        iconClass: 'text-amber-700', styleClass: 'kt-menu-item-amber',
        routerLink: '/presupuestos/historial' },
      { label: 'Historial de cotizaciones', icon: 'pi pi-file-o',
        iconClass: 'text-teal-700', styleClass: 'kt-menu-item-teal',
        routerLink: '/cotizador/historial' },
      { label: 'Historial de atenciones', icon: 'pi pi-history',
        iconClass: 'text-indigo-700', styleClass: 'kt-menu-item-indigo',
        routerLink: '/historial' },
      // Master data al final — referencia/edición, no consulta operativa.
      { label: 'Clientes', icon: 'pi pi-users',
        iconClass: 'text-rose-700', styleClass: 'kt-menu-item-rose',
        routerLink: '/clientes' },
      { label: 'Productos', icon: 'pi pi-box',
        iconClass: 'text-emerald-700', styleClass: 'kt-menu-item-emerald',
        routerLink: '/productos' },
    ]},
    { label: 'Administración', items: [
      { label: 'Configuración', icon: 'pi pi-cog',
        iconClass: 'text-slate-700', styleClass: 'kt-menu-item-slate',
        routerLink: '/configuracion' },
    ]},
  ];
}
