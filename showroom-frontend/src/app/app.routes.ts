import { Routes } from '@angular/router';
import { authGuard } from './auth/auth.guard';

export const routes: Routes = [
  // Rutas públicas — no requieren login.
  {
    path: 'login',
    loadComponent: () =>
      import('./auth/login-page/login-page').then((m) => m.LoginPage),
  },
  {
    path: 'visor',
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
