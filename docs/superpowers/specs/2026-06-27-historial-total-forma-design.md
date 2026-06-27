# Historial: total y nombre de la forma de pago elegida en la lista

Fecha: 2026-06-27

## Objetivo

En el historial de presupuestos (`presupuestos-historial-page`), cuando un
presupuesto tiene una **forma de pago elegida**:

1. La columna **Total** de la fila muestra el total **en esa forma** (no el
   Efectivo), con un **badge** del nombre de la forma al lado.
2. El detalle expandido muestra una línea **"Forma de pago: {nombre}"**.

## Contexto actual

- La columna Total de la fila muestra `p.totalSinIva` (= `subtotalSinIva`
  persistido), que es **siempre Efectivo** y no conoce la forma elegida.
- La lista (`PresupuestoListItemDTO`) **no carga** `formasPagoJson` (por
  performance en el listado paginado), así que no tiene el total/nombre de la
  forma.
- El **detalle** (`PresupuestoDetalle`) sí los tiene: `totalPresupuesto(det)` ya
  devuelve el total de la forma (`precioFinal`), y `formaSeleccionadaDe(det)` da
  la forma elegida (con `nombre`). El detalle ya funciona; falta mostrar el
  nombre y arreglar la columna de la lista.

## Diseño

### Backend — persistir total y nombre de la forma elegida

Para que la lista no tenga que deserializar las formas por fila, se persiste el
total y el nombre de la forma al guardar.

- **Entity `PresupuestoComercial`**: dos columnas nullable nuevas:
  - `totalFormaSeleccionada` (`BigDecimal`, `precision = 18, scale = 2`).
  - `formaPagoSeleccionadaNombre` (`String`, `length = 100`).
  - Null en ambas = "Todas" (la lista cae a `subtotalSinIva` / sin badge).
- **`aplicarDatos(p, datos)`**: tras setear `formaPagoSeleccionadaId`, resolver la
  forma elegida en `datos.formasPago()` por ese id:
  - Si existe: `setTotalFormaSeleccionada(forma.precioFinal())` y
    `setFormaPagoSeleccionadaNombre(forma.nombre())`.
  - Si no hay forma elegida o no se encuentra: ambos `null`.
  - No recalcula nada — usa el `precioFinal` del snapshot que ya manda el front.
- **`PresupuestoListItemDTO`**: agregar `BigDecimal totalFormaSeleccionada` y
  `String formaPagoSeleccionadaNombre` (al final del record).
- **`toListItemDTO`**: pasar `p.getTotalFormaSeleccionada()` y
  `p.getFormaPagoSeleccionadaNombre()`.

### Frontend — modelo

- **`models.ts` `PresupuestoListItem`**: agregar
  `totalFormaSeleccionada?: number | null` y
  `formaPagoSeleccionadaNombre?: string | null`.

### Frontend — columna Total de la lista

En la celda de la columna Total (`presupuestos-historial-page.html`):

- Mostrar `p.totalFormaSeleccionada ?? p.totalSinIva`.
- Cuando `p.formaPagoSeleccionadaNombre` está presente, mostrar un badge chico
  con ese nombre junto al total (estilo consistente con los demás pills de la
  fila), aclarando que el total es en esa forma. Sin forma → solo el total
  Efectivo, como hoy.

### Frontend — línea en el detalle

En el bloque "Presupuesto" del detalle, después de la línea "Cotización", agregar
(solo si `formaSeleccionadaDe(det)` no es null):

```
Forma de pago    {nombre de la forma}
```

usando `formaSeleccionadaDe(det)?.nombre`.

## Migración / compatibilidad

- Columnas nullable, `ddl-auto` (sin migración manual).
- Presupuestos creados antes de este cambio (con `formaPagoSeleccionadaId` pero
  sin estos campos persistidos) muestran Efectivo / sin badge en la **lista**
  hasta que se vuelvan a guardar; el **detalle** los muestra bien (recalcula del
  snapshot). Caso transitorio menor, sin retro-relleno.
- "Todas" (sin forma) ⇒ lista y detalle idénticos a hoy.

## Out of scope (YAGNI)

- No se toca el cálculo del PDF ni el flujo de pedido.
- No se retro-rellenan presupuestos viejos.
- No se cambia el `subtotalSinIva` persistido (sigue siendo Efectivo, base
  estable).

## Verificación

- Un presupuesto con forma elegida: la columna Total de la fila muestra el total
  de la forma + badge con su nombre; el detalle muestra "Forma de pago: X" y el
  mismo total.
- Un presupuesto "Todas" (o viejo sin los campos): columna en Efectivo, sin
  badge, sin línea de forma — como hoy.
- Backend en verde (`mvn -f showroom-backend/pom.xml test`) y frontend compila.
