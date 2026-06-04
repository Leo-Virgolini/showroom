# Presupuestos: IVA por rubro (perfiles menaje/maquinaria)

Fecha: 2026-06-04

## Problema

La sección de armado de presupuestos (`presupuestos-page`), su backend
(`PresupuestoComercialService`) y el generador de PDF
(`PresupuestoComercialPdfGenerator`) quedaron fuera de la unificación de
"IVA por rubro" ya aplicada en showroom/scan/visor/carrito/pedidos.

Síntomas:
- Muestra `PVP s/IVA` plano para todos los productos.
- Calcula las formas de pago **globalmente** usando solo el perfil menaje
  (`aplicaIva` de la forma), sin distinguir el rubro de cada ítem. Para un
  presupuesto con maquinaria los montos (Efectivo/Transferencia/cuotas) salen
  mal.
- La exclusión de descuentos por escala usa la constante hardcodeada
  `RUBROS_SIN_DESCUENTO_ESCALA`, no la lista configurable `precios.rubros-sin-iva`.

El rubro **ya viaja por ítem** al backend (en `GenerarPresupuestoRequestDTO.Item`
y en el `itemsJson` persistido); lo que falta es aplicar el perfil por rubro.

## Decisiones (confirmadas con el usuario)

1. **Alcance: completo** — frontend (armado), backend (cálculo/persistencia) y
   PDF generado.
2. **Precio mostrado: según el rubro** — menaje `c/IVA`, maquinaria `s/IVA`,
   con su etiqueta correcta, en armado y PDF. El sin-IVA se sigue usando para
   los umbrales de descuento por escala.
3. **Arquitectura:** mantener el patrón actual (el frontend calcula los montos
   y el backend persiste + el PDF vuelca), pero (a) el frontend calcula
   **per-ítem según rubro** (mismo patrón que el carrito del showroom) y (b) en
   el backend se extrae la fórmula de perfiles a un **calculador compartido**
   para que Presupuesto y Showroom no diverjan.

## Diseño

### Frontend — `presupuestos-page`
- Cargar `rubrosSinIva` (endpoint público ya existente) + `formasPagoActivas`.
- Reusar `precioPorForma` (de `precio-referencia.util`) y un `perfilForma(forma,
  esMaq)` per-ítem (copiado del patrón de `showroom-page`).
- Precio en búsqueda/detalle: según rubro (`c/IVA` menaje, `s/IVA` maquinaria) +
  etiqueta. Sin-IVA se mantiene para los umbrales de escala.
- Montos de formas de pago (barra inferior + lo enviado): calculados **per-ítem**
  (agregado = suma por ítem con el perfil de su rubro; individual = por ítem),
  reusando la mecánica de `totalParaForma` del carrito.
- Exclusión de escala: usar la lista configurable `rubrosSinIva`, no la constante.
- Snapshot de forma de pago enviado: agregar `recargoPorcentajeMaquinaria` y
  `aplicaIvaMaquinaria` (el rubro ya viaja por ítem).

### Backend
- `GenerarPresupuestoRequestDTO.FormaPagoSnapshot`: agregar
  `recargoPorcentajeMaquinaria` y `aplicaIvaMaquinaria` (se persisten en
  `formasPagoJson`).
- Extraer la fórmula de perfiles (`recargoPerfil`, `aplicaIvaPerfil`,
  `calcularSinIva`, `aplicarRecargoSinIva`, `calcularPrecioFinal`,
  `normalizarRubro`) a un componente compartido (`PrecioPerfilCalculator`).
  `ShowroomService` pasa a delegar en él (manteniendo sus métodos como wrappers
  para no romper sus tests/consumidores).
- `PresupuestoComercialService.forzarModoAgregado` / `forzarModoIndividual`:
  recalcular per-ítem con el calculador + `ConfiguracionService.getRubrosSinIva()`,
  en vez de la fórmula global.

### PDF — `PresupuestoComercialPdfGenerator`
- Tabla de productos: precio por línea **según rubro** (no `s/IVA` plano
  dividiendo siempre).
- `RUBROS_SIN_DESCUENTO_ESCALA` hardcodeado → leer
  `ConfiguracionService.getRubrosSinIva()` (inyectar el servicio).
- Cards de formas de pago: usan el `precioFinal` ya correcto; el badge
  `c/IVA`/`s/IVA` deja de ser global — en presupuesto mixto se resuelve per-ítem
  o se reemplaza por una nota (mismo criterio que pedidos).

### Compatibilidad
- Presupuestos viejos cuyo snapshot no traiga los campos de maquinaria →
  fallback al perfil menaje (comportamiento actual). Sin migración de datos.

## Verificación
- `mvn test` (backend) y `npx ng build` (frontend) en verde.
- Chequeo manual: presupuesto solo-menaje (igual que antes), solo-maquinaria
  (s/IVA, formas con perfil maquinaria), y mixto (montos per-ítem coherentes
  con el carrito del showroom).
