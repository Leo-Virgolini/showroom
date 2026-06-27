# Chips/cards de forma de pago clickeables + más grandes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hacer clickeables los chips del footer y las cards del panel expandido de `/presupuestos` para seleccionar la forma de pago (toggle a "Todas"), agrandar los chips, y resaltar la forma seleccionada.

**Architecture:** Frontend-only en `presupuestos-page`. Un método `seleccionarForma(id)` togglea el signal `formaPagoSeleccionadaId` ya existente, que sincroniza el dropdown de la toolbar y el precio en vivo (ya implementados). Los `<span>` estáticos de los chips pasan a `<button>`; las cards reciben `(click)`. El estado "seleccionado" se compone como clase en el template/TS (no con `[class.x]` separado, por el patrón del componente) y se estiliza en SCSS.

**Tech Stack:** Angular 21 (signals, control-flow `@for`/`@if`) + PrimeNG + Tailwind/SCSS.

## Global Constraints

- Toggle: clic en la forma ya seleccionada → `formaPagoSeleccionadaId = null` ("Todas").
- Solo modo Agregado (`!cotizacionIndividual()`). Individual: sin cambios.
- El estado "seleccionado" y el "mejor precio" coexisten (una forma puede ser ambas). No tocar el resaltado "mejor precio" (`kt-forma-chip-mejor` / `es-mejor-precio`).
- No combinar `[class]="expr"` con `[class.x]` en el mismo elemento (rompe el toggle de "mejor precio" — patrón existente): el estado seleccionado se compone dentro de la string de `[class]` / `clasesFormaCard`.
- No se persiste nada nuevo (el signal ya se manda/persiste); no se toca el flujo de pedido ni el cálculo de precios.

---

### Task 1: Selección por clic + estado seleccionado + chips más grandes

**Files:**
- Modify: `showroom-frontend/src/app/showroom/presupuestos-page/presupuestos-page.ts` (método nuevo ~tras `setModoCotizacion`/`formaPagoSeleccionadaId`; `clasesFormaCard` ~664)
- Modify: `showroom-frontend/src/app/showroom/presupuestos-page/presupuestos-page.html` (chips ~860-869; cards ~724)
- Modify: `showroom-frontend/src/app/showroom/presupuestos-page/presupuestos-page.scss` (`.kt-forma-chip` ~519; quitar/ignorar `.kt-forma-chip-estatico`; nuevos estados `~`)

**Interfaces:**
- Consumes: `formaPagoSeleccionadaId` (signal existente), `formasPagoFooter()` (chips, items con `id`/`nombre`/`precioFinal`/`indiceOriginal`/`esMejorPrecio`), `formasPagoCalculadas()` (cards, items con `id`), `indiceMejorPrecio()`.
- Produces: `seleccionarForma(id: number | null): void`.

- [ ] **Step 1: Agregar el método `seleccionarForma`**

En `presupuestos-page.ts`, junto a `formaPagoSeleccionadaId` (~356) o `setModoCotizacion`, agregar:

```typescript
  /** Selecciona/deselecciona una forma de pago desde un chip o card del footer.
   *  Toggle: si ya está seleccionada, vuelve a "Todas" (null). Setea el mismo
   *  signal que el dropdown de la toolbar, así el precio en vivo y el PDF la
   *  toman automáticamente. */
  seleccionarForma(id: number | null): void {
    this.formaPagoSeleccionadaId.set(this.formaPagoSeleccionadaId() === id ? null : id);
  }
```

- [ ] **Step 2: Marcar la card seleccionada en `clasesFormaCard`**

En `presupuestos-page.ts`, reemplazar `clasesFormaCard` (~664-668):

```typescript
  clasesFormaCard(i: number): string {
    const colorClass = `color-${(i % 10) + 1}`;
    const mejorClass = i === this.indiceMejorPrecio() ? ' es-mejor-precio' : '';
    const sel = this.formasPagoCalculadas()[i]?.id === this.formaPagoSeleccionadaId()
      ? ' seleccionada'
      : '';
    return `forma-pago-card ${colorClass}${mejorClass}${sel}`;
  }
```

- [ ] **Step 3: Chips del footer → `<button>` clickeable + estado seleccionado (HTML)**

En `presupuestos-page.html`, reemplazar el chip estático (~860-869):

```html
              <span
                [class]="'kt-forma-chip kt-forma-chip-estatico color-' + ((f.indiceOriginal % 10) + 1) + (f.esMejorPrecio ? ' kt-forma-chip-mejor' : '')">
                @if (f.esMejorPrecio) {
                  <i class="pi pi-check-circle text-[10px]"></i>
                }
                <span class="font-bold kt-forma-chip-nombre">{{ f.nombre }}</span>
                <span class="kt-forma-chip-precio">
                  {{ f.precioFinal | currency:'ARS':'symbol':'1.0-0' }}
                </span>
              </span>
```

por:

```html
              <button type="button"
                (click)="seleccionarForma(f.id)"
                [pTooltip]="f.id === formaPagoSeleccionadaId() ? 'Forma seleccionada — tocá para volver a Todas' : 'Cotizar todo el presupuesto en esta forma'"
                tooltipPosition="top"
                [class]="'kt-forma-chip color-' + ((f.indiceOriginal % 10) + 1) + (f.esMejorPrecio ? ' kt-forma-chip-mejor' : '') + (f.id === formaPagoSeleccionadaId() ? ' kt-forma-chip-seleccionado' : '')">
                @if (f.esMejorPrecio) {
                  <i class="pi pi-check-circle text-[10px]"></i>
                }
                <span class="font-bold kt-forma-chip-nombre">{{ f.nombre }}</span>
                <span class="kt-forma-chip-precio">
                  {{ f.precioFinal | currency:'ARS':'symbol':'1.0-0' }}
                </span>
              </button>
```

(Se quita `kt-forma-chip-estatico` — la clase que anulaba el affordance de clic; el `.kt-forma-chip` base ya trae `cursor: pointer`.)

- [ ] **Step 4: Cards del panel expandido → clickeables (HTML)**

En `presupuestos-page.html`, en el `@for` de cards del panel (~724), agregar el `(click)` al `<div [class]="clasesFormaCard(i)">`:

```html
                  <div [class]="clasesFormaCard(i)" (click)="seleccionarForma(f.id)"
                    [pTooltip]="f.id === formaPagoSeleccionadaId() ? 'Forma seleccionada — tocá para volver a Todas' : 'Cotizar todo el presupuesto en esta forma'"
                    tooltipPosition="top">
```

(El `f` del `@for (f of formasPagoCalculadas(); track f.id; let i = $index)` tiene `id`. El cursor pointer se agrega en SCSS sobre `.forma-pago-card` en el Step 5, para no mezclar `class` estático con `[class]`.)

- [ ] **Step 5: SCSS — chips más grandes, reset de `<button>`, estado seleccionado y cursor en cards**

En `presupuestos-page.scss`, en `:host ::ng-deep .kt-forma-chip` (~519-533), agrandar y resetear el `<button>` (las propiedades nuevas/cambiadas):

```scss
:host ::ng-deep .kt-forma-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.45rem 0.85rem;
  border-radius: 999px;
  background: var(--p-surface-50);
  border: 1px solid rgba($kt-naranja, 0.2);
  color: $kt-marron;
  font-size: 0.82rem;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  white-space: nowrap;
  flex: 0 0 auto;
  min-width: 0;

  > i {
    color: $kt-naranja;
    font-size: 0.9rem;
    flex-shrink: 0;
  }

  .kt-forma-chip-nombre {
    white-space: nowrap;
  }
}
```

Agregar el estado seleccionado del chip (doble selector para subir especificidad, como `kt-forma-chip-mejor`). Insertar tras el bloque `:host ::ng-deep .kt-forma-chip-mejor...`:

```scss
// Forma de pago SELECCIONADA — anillo naranja KT. Coexiste con "mejor precio"
// (verde): usamos outline en vez de box-shadow para no pisar el halo verde.
:host ::ng-deep .kt-forma-chip-seleccionado.kt-forma-chip-seleccionado {
  outline: 2.5px solid $kt-naranja;
  outline-offset: 1.5px;
}
```

Agregar el estado seleccionado de la card + cursor pointer. En `:host ::ng-deep .forma-pago-card` (~328), agregar `cursor: pointer;` a la regla base, y tras el bloque `&.es-mejor-precio { ... }` (dentro de la misma regla `.forma-pago-card`), agregar:

```scss
  &.seleccionada {
    outline: 2.5px solid $kt-naranja;
    outline-offset: 2px;
  }
```

- [ ] **Step 6: Verificar el build**

Run: `cd showroom-frontend && npm run build`
Expected: build OK (sin errores de template; `<button>` y `pTooltip` válidos).

- [ ] **Step 7: Verificación manual (humano)**

En `/presupuestos` (Agregado) con ítems:
- Clic en un chip del footer → esa forma queda con anillo naranja; el dropdown de la toolbar la marca; la tabla y el total muestran su precio.
- Clic en la misma → vuelve a "Todas" (dropdown limpio, precios Efectivo, sin anillo).
- Abrir el panel (chevron) → clic en una card hace lo mismo; la card seleccionada muestra el anillo.
- El "mejor precio" sigue resaltado (verde/check) y puede coincidir con la seleccionada.
- Chips notablemente más grandes y legibles, en una sola fila.
- Modo Individual: el footer no cambia (chip "Cotización individual").

- [ ] **Step 8: Commit**

```bash
git add showroom-frontend/src/app/showroom/presupuestos-page/presupuestos-page.ts \
        showroom-frontend/src/app/showroom/presupuestos-page/presupuestos-page.html \
        showroom-frontend/src/app/showroom/presupuestos-page/presupuestos-page.scss
git commit -m "feat(presupuestos): chips/cards de forma de pago clickeables (seleccionan la forma) + más grandes"
```

---

## Notas de verificación final

- Frontend compila (`cd showroom-frontend && npm run build`).
- Seleccionar/deseleccionar desde chip y card sincroniza dropdown + precio en vivo + PDF.
- `.kt-forma-chip-estatico` ya no se usa en el template; puede quedar en el SCSS sin efecto (o eliminarse si se prefiere — opcional, no bloquea).
