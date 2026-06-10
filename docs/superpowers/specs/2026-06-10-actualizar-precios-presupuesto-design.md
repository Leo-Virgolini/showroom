# Botón "Actualizar precios" en la edición de presupuestos

**Fecha:** 2026-06-10
**Pantalla:** `/presupuestos/editar/:id` (componente `PresupuestosPage`)

## Problema

Un presupuesto guardado congela los precios del momento en que se creó (en
`items_json`). Al editar un presupuesto viejo, esos precios pueden estar
desactualizados respecto al catálogo actual. La carga en modo edición
**deliberadamente NO pisa los precios** (ver `cargarParaEditar`, el `lookupBulk`
solo trae descripción/stock/imagen) para no cambiarlos sin querer. Hace falta
una acción **explícita** que traiga los precios actuales cuando el operador lo
decida.

## Solución

Un botón "Actualizar precios" en el toolbar, visible solo en modo edición, que
reemplaza los precios de los ítems por los del catálogo local (cache en BD), sin
tocar DUX y conservando cantidades y descuentos.

### Fuente de los precios

`lookupBulk(skus)` → `POST /api/showroom/lookup` → devuelve `CatalogoItem[]`
desde el cache local en BD. Instantáneo, no pega a DUX. Ya existe y ya se usa en
`cargarParaEditar`. `CatalogoItem` incluye `pvpKtGastroConIva`,
`pvpKtGastroSinIva`, `porcIva` y `rubro` — todos los campos que el botón
necesita.

**Cero cambios en el backend.**

### Comportamiento (`actualizarPreciosDesdeCatalogo()`)

1. Junta los SKUs de los ítems **no genéricos** (los genéricos usan el SKU
   comodín y no representan un producto del catálogo → se saltan, igual que el
   lookup de carga).
2. Confirmación previa con `ConfirmationService` (global, ya disponible):
   *"Esto reemplaza los precios de este presupuesto por los del catálogo actual.
   Las cantidades y descuentos se conservan. ¿Continuar?"*
3. Al aceptar, llama `lookupBulk(skus)`.
4. Por cada ítem encontrado, pisa **solo** `pvpKtGastroConIva`,
   `pvpKtGastroSinIva`, `porcIva` y `rubro`. Conserva intactos `cantidad`,
   `descuentoPorcentaje`, `uid`, `comentarios`, `generico`, `sku`.
5. Reemplaza el array con `items.set(...)` + `itemsTick.update(v => v+1)`.
   `precioMostrado` y todos los totales/formas de pago son `computed` derivados
   de esos campos → el footer y los subtotales se recalculan solos.
6. Marca `hayCambiosSinGuardar.set(true)` si hubo al menos un precio distinto.

### Descuentos

El `descuentoPorcentaje` de cada ítem se **conserva** y se aplica sobre el precio
nuevo (10% sigue siendo 10%, ahora sobre el precio actualizado). Coherente con el
resto de la pantalla.

### Feedback

Toast resumen al terminar, p. ej.:
*"3 precios actualizados, 1 sin cambios, 1 SKU ya no está en el catálogo."*
Los ítems no encontrados en el cache se dejan tal cual (no se borran ni se
marcan como error).

### UI

- Botón en `presupuestos-page.html`, dentro del bloque `@if (esModoEdicion())`
  del toolbar (junto a "Crear pedido").
- Ícono `pi pi-dollar`, label "Actualizar precios" (oculto en mobile como los
  demás botones del toolbar, vía `screenLg()`).
- `[loading]="actualizandoPrecios()"` y `[disabled]` mientras carga.
- Tooltip: *"Trae los precios actuales del catálogo (no toca DUX). Conserva
  cantidades y descuentos."*
- Solo se muestra si hay al menos un ítem no genérico.

## Fuera de alcance

- No cambia el backend.
- No cambia el guardado (sigue por el PUT actual al tocar "Guardar cambios").
- No actualiza genéricos.
- No cambia la carga inicial (que sigue sin pisar precios a propósito).
- No consulta DUX en vivo.

## Archivos afectados

- `showroom-frontend/src/app/showroom/presupuestos-page/presupuestos-page.ts`
  (método nuevo + signal `actualizandoPrecios` + inyectar `ConfirmationService`).
- `showroom-frontend/src/app/showroom/presupuestos-page/presupuestos-page.html`
  (botón nuevo en el toolbar).
