import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./showroom/showroom-page/showroom-page').then((m) => m.ShowroomPage),
  },
  {
    path: 'etiquetas',
    loadComponent: () =>
      import('./showroom/etiquetas-page/etiquetas-page').then((m) => m.EtiquetasPage),
  },
  {
    path: 'productos',
    loadComponent: () =>
      import('./showroom/productos-page/productos-page').then((m) => m.ProductosPage),
  },
  {
    path: 'pedidos',
    loadComponent: () =>
      import('./showroom/pedidos-page/pedidos-page').then((m) => m.PedidosPage),
  },
  {
    path: 'configuracion',
    loadComponent: () =>
      import('./showroom/configuracion-page/configuracion-page').then((m) => m.ConfiguracionPage),
  },
  {
    path: 'visor',
    loadComponent: () =>
      import('./showroom/visor-page/visor-page').then((m) => m.VisorPage),
  },
  { path: '**', redirectTo: '' },
];
