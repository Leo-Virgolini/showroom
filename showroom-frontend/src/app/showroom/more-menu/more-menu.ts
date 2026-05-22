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

  /** Estructura del menú — fuente única para toda la app. Si en el futuro
   *  se agregan nuevas pantallas, solo se modifica acá. */
  readonly items: MenuItem[] = [
    { label: 'Consultas', items: [
      { label: 'Pedidos', icon: 'pi pi-receipt', routerLink: '/pedidos' },
      { label: 'Historial de presupuestos', icon: 'pi pi-file', routerLink: '/presupuestos/historial' },
      { label: 'Historial de atenciones', icon: 'pi pi-history', routerLink: '/historial' },
      { label: 'Clientes', icon: 'pi pi-users', routerLink: '/clientes' },
      { label: 'Productos', icon: 'pi pi-box', routerLink: '/productos' },
    ]},
    { label: 'Herramientas', items: [
      { label: 'Armar presupuesto', icon: 'pi pi-file-edit', routerLink: '/presupuestos' },
      { label: 'Imprimir etiquetas QR', icon: 'pi pi-tags', routerLink: '/etiquetas' },
    ]},
    { label: 'Administración', items: [
      { label: 'Configuración', icon: 'pi pi-cog', routerLink: '/configuracion' },
    ]},
  ];
}
