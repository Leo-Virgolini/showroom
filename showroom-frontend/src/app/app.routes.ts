import { Routes } from '@angular/router';
import { authGuard } from './auth/auth.guard';
import { unsavedChangesGuard } from './showroom/presupuestos-page/unsaved-changes.guard';

export const routes: Routes = [
  // Rutas públicas — no requieren login.
  {
    path: 'login',
    loadComponent: () =>
      import('./auth/login-page/login-page').then((m) => m.LoginPage),
  },
  {
    path: 'visor/:username',
    loadComponent: () =>
      import('./showroom/visor-page/visor-page').then((m) => m.VisorPage),
  },

  // Rutas protegidas — requieren sesión activa.
  {
    path: '',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./showroom/showroom-page/showroom-page').then((m) => m.ShowroomPage),
  },
  {
    path: 'etiquetas',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./showroom/etiquetas-page/etiquetas-page').then((m) => m.EtiquetasPage),
  },
  {
    path: 'productos',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./showroom/productos-page/productos-page').then((m) => m.ProductosPage),
  },
  {
    path: 'pedidos',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./showroom/pedidos-page/pedidos-page').then((m) => m.PedidosPage),
  },
  {
    path: 'presupuestos',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./showroom/presupuestos-page/presupuestos-page').then((m) => m.PresupuestosPage),
  },
  {
    // Mismo componente que `/presupuestos`, pero arranca cargando el detalle
    // del presupuesto :id y guarda con PUT en lugar de POST. El
    // {@link unsavedChangesGuard} intercepta la navegación cuando hay
    // cambios pendientes para que el operador no pierda trabajo por error.
    path: 'presupuestos/editar/:id',
    canActivate: [authGuard],
    canDeactivate: [unsavedChangesGuard],
    loadComponent: () =>
      import('./showroom/presupuestos-page/presupuestos-page').then((m) => m.PresupuestosPage),
  },
  {
    path: 'presupuestos/historial',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./showroom/presupuestos-historial-page/presupuestos-historial-page')
        .then((m) => m.PresupuestosHistorialPage),
  },
  // Cotizador de financiación — pantalla "rápida": un monto base + formas
  // de pago + PDF. Sin productos, paralelo al presupuestador completo.
  {
    path: 'cotizador',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./showroom/cotizador-page/cotizador-page').then((m) => m.CotizadorPage),
  },
  {
    path: 'cotizador/editar/:id',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./showroom/cotizador-page/cotizador-page').then((m) => m.CotizadorPage),
  },
  {
    path: 'cotizador/historial',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./showroom/cotizador-historial-page/cotizador-historial-page')
        .then((m) => m.CotizadorHistorialPage),
  },
  {
    // Ruta nueva (mayo 2026): ahora la página unifica clientes de presupuestos
    // y pedidos, así que el path bajo /presupuestos quedaba engañoso. Está en
    // el menú "+" principal del showroom-page.
    path: 'clientes',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./showroom/presupuestos-clientes-page/presupuestos-clientes-page')
        .then((m) => m.PresupuestosClientesPage),
  },
  // Redirect del path viejo para no romper bookmarks ni links externos.
  {
    path: 'presupuestos/clientes',
    redirectTo: 'clientes',
    pathMatch: 'full',
  },
  {
    path: 'historial',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./showroom/historial-page/historial-page').then((m) => m.HistorialPage),
  },
  {
    path: 'configuracion',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./showroom/configuracion-page/configuracion-page').then((m) => m.ConfiguracionPage),
  },
  { path: '**', redirectTo: '' },
];
