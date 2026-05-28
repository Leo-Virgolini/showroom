import {
  ApplicationConfig,
  DEFAULT_CURRENCY_CODE,
  LOCALE_ID,
  isDevMode,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideHttpClient, withFetch, withInterceptors, withXsrfConfiguration } from '@angular/common/http';
import { registerLocaleData } from '@angular/common';
import localeEsAr from '@angular/common/locales/es-AR';
import localeEsArExtra from '@angular/common/locales/extra/es-AR';
import { ConfirmationService } from 'primeng/api';
import { providePrimeNG } from 'primeng/config';
import { definePreset } from '@primeuix/themes';
import Aura from '@primeuix/themes/aura';

/**
 * Preset KT Gastronomía — sobreescribe el primary de Aura con la paleta naranja
 * de la marca (255, 134, 28 = #FF861C). Los demás colores (surface, success,
 * warn, danger) quedan los defaults de Aura. Un solo preset = consistencia
 * automática en botones, focus rings, links, badges, etc. en toda la app.
 */
const KTPreset = definePreset(Aura, {
  semantic: {
    primary: {
      50: '#fff5eb',
      100: '#ffe4c7',
      200: '#ffd29f',
      300: '#ffb866',
      400: '#ff9a35',
      500: '#FF861C',
      600: '#e67014',
      700: '#bf5908',
      800: '#8c3f00',
      900: '#5c2900',
      950: '#331600',
    },
  },
});

import { routes } from './app.routes';
import { provideServiceWorker } from '@angular/service-worker';
import { backendStatusInterceptor } from './showroom/backend-status.interceptor';
import { clientIdInterceptor } from './showroom/client-id.interceptor';
import { authInterceptor } from './auth/auth.interceptor';
import { PRIMENG_LOCALE_ES } from './primeng-locale-es';

// Registramos los datos del locale es-AR para que pipes como currency, date,
// number y decimal usen formato argentino sin tener que pasar el locale en cada
// invocación.
registerLocaleData(localeEsAr, 'es-AR', localeEsArExtra);

export const appConfig: ApplicationConfig = {
  providers: [
    { provide: LOCALE_ID, useValue: 'es-AR' },
    { provide: DEFAULT_CURRENCY_CODE, useValue: 'ARS' },
    // Servicio global para confirmaciones. Se usa con el componente
    // <p-confirmDialog> declarado en app.html — cada llamada a
    // confirmationService.confirm({...}) abre el mismo dialog reutilizable
    // en vez de tener que componer un <p-dialog> por cada caso.
    ConfirmationService,
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    provideHttpClient(
      withFetch(),
      // CSRF: Spring Security manda la cookie `XSRF-TOKEN` y espera el header
      // `X-XSRF-TOKEN` en requests mutantes. Angular lo hace automáticamente.
      withXsrfConfiguration({ cookieName: 'XSRF-TOKEN', headerName: 'X-XSRF-TOKEN' }),
      withInterceptors([authInterceptor, clientIdInterceptor, backendStatusInterceptor]),
    ),
    providePrimeNG({
      theme: {
        preset: KTPreset,
        options: {
          darkModeSelector: '.app-dark',
          // Inyecta los estilos de PrimeNG en un layer "primeng" entre `theme`
          // y `base` de Tailwind. Como `components` y `utilities` no se mencionan,
          // van automáticamente al final → las utilities Tailwind (pl-12, w-full,
          // !p-4, etc.) ganan sobre los estilos default de PrimeNG.
          cssLayer: {
            name: 'primeng',
            order: 'theme, base, primeng',
          },
        },
      },
      ripple: true,
      // Locale en español para todos los componentes de PrimeNG (datepicker,
      // paginator, file upload, etc.). Source de verdad: primefaces/primelocale
      // (es.json). Sin esto los labels propios de PrimeNG aparecen en inglés.
      translation: PRIMENG_LOCALE_ES,
    }),
    provideServiceWorker('ngsw-worker.js', {
      enabled: !isDevMode(),
      registrationStrategy: 'registerWhenStable:30000',
    }),
  ],
};
