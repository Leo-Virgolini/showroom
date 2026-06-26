# Mejoras de la forma de pago en presupuestos

Fecha: 2026-06-26

## Objetivo

Refinar la feature "forma de pago en presupuesto agregado" (ya en main) con 8
mejoras de UI, comportamiento en vivo, historial, edición y PDF.

## Contexto actual (lo que existe hoy)

- En `/presupuestos` hay un `<p-select>` de forma de pago (`formaPagoSeleccionadaId`,
  default "Todas") en la toolbar; **solo afecta el PDF**.
- La tabla de ítems y el total de la pantalla siempre muestran el precio
  **Efectivo** (referencia) — `precioMostrado(it)` y `subtotalReferencia` no
  dependen de la forma elegida.
- El historial (`PresupuestoDetalleDTO` / `PresupuestoDetalle`) **no expone**
  `formaPagoSeleccionadaId`, aunque la entity sí lo persiste.
- El dropdown no muestra íconos; el footer de chips de formas trunca los nombres.

## Principio transversal (no romper nada)

El cambio de "precio en vivo por forma" es **solo de visualización**. Lo que se
**persiste y alimenta el pedido** no cambia: el payload sigue mandando
`precioReferencia` (Efectivo) por ítem y `subtotalSinIva` (Efectivo); el PDF se
expresa en la forma vía `formaPagoSeleccionadaId` como ya hace. El total y los
precios "de la forma" se **derivan/calculan** para mostrar, nunca pisan la base
Efectivo persistida.

---

## 0. Base habilitante — exponer `formaPagoSeleccionadaId` (backend + TS)

Necesario para los puntos 4 y 5.

- `PresupuestoDetalleDTO` (record): agregar `Long formaPagoSeleccionadaId` y
  mapearlo desde `PresupuestoComercial.getFormaPagoSeleccionadaId()` donde se
  arma el detalle (en `PresupuestoComercialService`).
- `models.ts` `PresupuestoDetalle`: agregar `formaPagoSeleccionadaId?: number | null`.

## 1. Layout del selector — label pegado a su input

El contenedor de la toolbar usa `flex-wrap`, y el label "FORMA DE PAGO" y el
`<p-select>` son dos hijos sueltos que el wrap separa en distinta fila.

**Fix:** envolver el `<span>` "FORMA DE PAGO" + el `<p-select>` en un único
sub-contenedor (`<div class="inline-flex items-center gap-1.5">`) para que viajen
juntos como una unidad; el wrap los mueve juntos, nunca uno sin el otro.

## 2. Íconos en el dropdown de forma de pago

Replicar el patrón del showroom (`showroom-page.html`): dentro del `<p-select>`,
agregar `<ng-template #selectedItem>` y `<ng-template #item>` con
`<i [class]="iconoForma(fp.nombre)" class="text-[#FF861C]"></i> {{ fp.nombre }}`,
reusando `iconoFormaReferencia` de `precio-referencia.util.ts` (Efectivo →
money-bill, Transferencia → arrows, cuotas/tarjeta → credit-card). Exponer un
helper `iconoForma(nombre)` en el componente.

La opción "Todas" (clear/placeholder) no lleva ícono (es el estado sin forma).

## 3. Precio en vivo por forma en `/presupuestos` (solo visual)

Cuando hay una forma elegida (`formaPagoSeleccionadaId != null`), la pantalla
muestra los precios en ESA forma; con "Todas" muestra Efectivo (como hoy).

- Nuevo getter visual `precioVisualItem(it)`: si hay forma elegida, calcula el
  precio unitario con `precioPorForma(it.pvpKtGastroConIva, it.porcIva,
  perfilForma(forma, rubroCotizaSinIva(it.rubro)))`; si no, cae a
  `precioMostrado(it)` (Efectivo, actual).
- Nuevo computed `subtotalVisual` análogo a `subtotalReferencia` pero usando
  `precioVisualItem`.
- La tabla de ítems del `.html` y el TOTAL del footer muestran
  `precioVisualItem`/`subtotalVisual` (incluyendo el tachado/ahorro, que se
  recalcula sobre la base visual).
- **No se toca** `precioMostrado(it)` ni el armado del payload: `precioReferencia`
  y `subtotalSinIva` que se mandan/persisten siguen siendo Efectivo.
- El footer de chips de formas (comparativo) sigue mostrando TODAS las formas
  (`formasPagoCalculadas`) — no se filtra; sólo el TOTAL principal refleja la
  forma elegida.

## 4. Historial — mostrar solo la forma elegida

En `presupuestos-historial-page`, cuando el detalle trae
`formaPagoSeleccionadaId != null` (y no es cotización individual):

- La sección "Formas de pago" muestra **solo la card de esa forma** (filtrar
  `formasGlobales(det)` por id), en vez de todas.
- El "Total presupuesto" y el precio por ítem del detalle se expresan en esa
  forma, recalculados en el front desde el snapshot: el total = `precioFinal` de
  la forma elegida; el precio por ítem = `precioPorForma(item.precioConIva,
  item.porcIva, perfilForma(formaElegida, rubroCotizaSinIva(item.rubro)))`.
- Sin forma elegida → comportamiento actual (Efectivo + todas las cards).

## 5. Edición — hidratar la forma seleccionada

En `cargarParaEditar(id)` de `presupuestos-page.ts`, tras recibir el detalle:
`this.formaPagoSeleccionadaId.set(det.formaPagoSeleccionadaId ?? null)`. Así el
dropdown viene marcado con la forma original; al re-guardar se conserva (el
payload ya manda `formaPagoSeleccionadaId`).

## 6. Modal de guardar — nombre del cliente obligatorio

En el diálogo de cliente (guardar/enviar), el teléfono ya es obligatorio (`*` +
validación). Aplicar lo mismo al **NOMBRE DEL CLIENTE**: agregar el asterisco `*`
al label y la validación que impide confirmar (Guardar cambios / Enviar) sin
nombre, con el mismo patrón de feedback que el teléfono.

## 7. Footer de chips — mostrar el nombre completo

Los chips (`.kt-forma-chip-nombre`) truncan el nombre con `ellipsis` aunque hay
espacio. Ajustar `.kt-footer-chips` / `.kt-forma-chip`:

- Quitar el `text-overflow: ellipsis` / `overflow: hidden` del nombre para que se
  muestre completo.
- Permitir que la fila de chips use varias líneas (`flex-wrap: wrap`) en lugar de
  comprimir todo en una sola, de modo que cada chip muestre su nombre entero.
- Mantener el resto (colores por índice, mejor precio, precio) igual.

## 8. PDF — header de la columna de precio con jerarquía

Cuando hay forma elegida, el header `PRECIO {NOMBRE}` se parte en varias líneas
del mismo peso y se amontona (ej. "PRECIO / TRANSFERENCIA / S/F").

**Fix en `agregarTablaDetalle`:** cuando hay forma elegida, renderizar la celda
del header de precio como dos párrafos: "PRECIO" (estilo actual del header) +
el nombre de la forma como subtítulo en fuente más chica (~7pt) y gris, debajo.
Sin forma ("Todas") queda "PRECIO EFECTIVO" como hoy (es corto). El total
(`Total {nombre}`) ya entra en una línea y no se toca.

## Out of scope (YAGNI)

- No se cambia el flujo de creación de pedido ni lo que factura DUX (sigue sobre
  la base Efectivo / la forma elegida en el diálogo de pedido).
- No se toca el modo de cotización individual (cada ítem ya lista sus formas).
- No se modifican las formas de pago ni su configuración.

## Verificación

- Selector: label y dropdown siempre juntos; el dropdown muestra íconos por forma.
- `/presupuestos`: elegir una forma cambia precio por ítem y total en pantalla;
  "Todas" vuelve a Efectivo. El PDF sigue saliendo correcto.
- Historial: un presupuesto con forma elegida muestra solo esa card y el total/
  precios en esa forma; uno sin forma, como hoy.
- Editar un presupuesto con forma elegida: el dropdown viene marcado con ella.
- Modal: no se puede guardar/enviar sin nombre ni sin teléfono.
- Footer: los nombres de las formas se ven completos.
- PDF: el header de la columna de precio se lee con jerarquía (PRECIO + forma),
  sin amontonarse.
- Backend en verde (`mvn -f showroom-backend/pom.xml test`) y frontend compila.
