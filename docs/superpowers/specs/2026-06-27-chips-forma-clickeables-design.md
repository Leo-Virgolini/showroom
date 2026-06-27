# Chips/cards de forma de pago clickeables + más grandes

Fecha: 2026-06-27

## Objetivo

En `/presupuestos`, hacer que los chips de forma de pago del footer (y las cards
del panel expandido) sean **clickeables para seleccionar la forma de pago**, y
agrandar los chips para que se lean cómodos.

## Contexto actual

- El footer compacto muestra chips por forma desde `formasPagoFooter()` como
  `<span class="kt-forma-chip kt-forma-chip-estatico ...">` — **informativos, no
  clickeables** (el comentario dice "El detalle se abre con el chevron, no
  tocando el chip"). Se resalta el "mejor precio" (`kt-forma-chip-mejor` + check).
- El panel expandido muestra cards desde `formasPagoCalculadas()` como
  `<div [class]="clasesFormaCard(i)">` (`clasesFormaCard` ya arma
  `forma-pago-card color-N es-mejor-precio`), con un badge "Mejor precio".
- El signal `formaPagoSeleccionadaId` (toolbar dropdown) ya gobierna el precio en
  vivo de la tabla/total y el PDF. Hoy los chips/cards no lo tocan.

## Comportamiento

- **Selección por clic:** clic en un chip o card setea `formaPagoSeleccionadaId`
  a esa forma. Como es el mismo signal del dropdown, se sincroniza solo: el
  dropdown de la toolbar la marca, la tabla y el total se expresan en esa forma
  (precio en vivo ya implementado), y el PDF saldrá en ella.
- **Toggle:** clic en la forma **ya seleccionada** vuelve a `null` ("Todas").
- Aplica solo en modo **Agregado**. En Individual el footer no lista formas
  seleccionables (chip "Cotización individual") — sin cambios. Las cards del panel
  en modo individual son por-producto (`formasPagoPorItem`) y **no** son
  seleccionables.

## Diseño

### Método de selección (presupuestos-page.ts)

```typescript
seleccionarForma(id: number | null): void {
  this.formaPagoSeleccionadaId.set(this.formaPagoSeleccionadaId() === id ? null : id);
}
```

### Chips del footer (HTML)

El `<span ... kt-forma-chip-estatico ...>` pasa a `<button type="button">`
clickeable con `(click)="seleccionarForma(f.id)"`. La clase incluye el estado
seleccionado cuando `f.id === formaPagoSeleccionadaId()` →
`kt-forma-chip-seleccionado`. Se reemplaza `kt-forma-chip-estatico` (que
significaba "no interactivo") por el chip clickeable.

### Cards del panel expandido (HTML + clasesFormaCard)

El `<div [class]="clasesFormaCard(i)">` recibe `(click)="seleccionarForma(...)"`
(la forma del índice `i`: `formasPagoCalculadas()[i].id`) y cursor pointer.
`clasesFormaCard(i)` agrega la clase `seleccionada` cuando
`formasPagoCalculadas()[i].id === formaPagoSeleccionadaId()` (se compone en TS,
no con `[class.x]` aparte, para no romper el toggle de "mejor precio" — patrón
existente del componente).

### Estado "seleccionado" (SCSS)

- `kt-forma-chip-seleccionado`: anillo/borde marcado (p. ej. `box-shadow` o
  `outline` con el naranja KT) que lo distingue del "mejor precio". Coexiste con
  `kt-forma-chip-mejor` (una forma puede ser la más barata y la seleccionada).
- `.forma-pago-card.seleccionada`: equivalente para la card (anillo/borde KT).

### Tamaño de los chips (SCSS)

Agrandar `.kt-forma-chip`: más padding, nombre y precio en fuente mayor, íconos
acorde — aprovechando el ancho completo del footer (ya sin `max-width`).

## Out of scope (YAGNI)

- No se cambia el chevron (sigue abriendo/cerrando el panel).
- No se cambia el resaltado "mejor precio" ni el cálculo de precios.
- No se toca el modo individual ni el flujo de pedido.
- No se persiste nada nuevo (formaPagoSeleccionadaId ya se persiste/manda).

## Verificación

- Clic en un chip o card → esa forma queda seleccionada (resaltada), el dropdown
  de la toolbar la marca, y la tabla/total muestran su precio.
- Clic en la seleccionada → vuelve a "Todas" (dropdown limpio, precios Efectivo).
- El "mejor precio" sigue resaltándose; puede coincidir con la seleccionada.
- Chips notablemente más grandes y legibles, en una sola fila.
- Modo individual sin cambios. Frontend compila (`npm run build`).
