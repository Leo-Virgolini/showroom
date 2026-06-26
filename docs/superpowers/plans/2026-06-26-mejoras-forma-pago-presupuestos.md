# Mejoras de forma de pago en presupuestos — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refinar la forma de pago en presupuestos: selector con label pegado + íconos, precio en vivo por forma en la pantalla, historial que muestra solo la forma elegida, hidratar la forma al editar, nombre de cliente obligatorio, footer de chips sin truncar, y header del PDF con jerarquía.

**Architecture:** Cambios mayormente de frontend (Angular 21 + PrimeNG) sobre `presupuestos-page` y `presupuestos-historial-page`, más un campo nuevo en el DTO de detalle (backend) que habilita historial/edición, y un retoque en el generador de PDF (iText). El "precio por forma" se calcula con las utilidades existentes `precioPorForma`/`perfilForma`; el dato persistido sigue siendo Efectivo.

**Tech Stack:** Angular 21 + PrimeNG 21 (`p-select`, `pTooltip`), Tailwind v4 / SCSS; Spring Boot 4 + Java 25 (record DTO, iText). Tests: `mvn -f showroom-backend/pom.xml test`, `cd showroom-frontend && npm run build`.

## Global Constraints

- **No romper la base Efectivo persistida:** el payload al guardar/generar sigue mandando `precioReferencia` (Efectivo) por ítem y el `subtotalSinIva` persistido sigue siendo Efectivo. El "precio por forma" es solo de visualización (pantalla, historial) y de PDF (vía `formaPagoSeleccionadaId`, ya implementado). NO tocar `precioMostrado(it)` ni el armado del payload.
- Cálculo de precio por forma: reusar `precioPorForma(conIva, porcIva, perfil)` y `perfilForma(forma, esMaquinaria)` existentes; `esMaquinaria` sale de `rubroCotizaSinIva(rubro)`. No reimplementar la fórmula.
- Íconos: reusar `iconoFormaReferencia(nombre)` de `precio-referencia.util.ts` (Efectivo → `pi pi-money-bill`, Transferencia → `pi pi-arrow-right-arrow-left`, cuotas/tarjeta → `pi pi-credit-card`).
- PrimeNG: usar atributo `class`, no `styleClass`.
- "Todas" (sin forma elegida) ⇒ comportamiento idéntico al actual (Efectivo en pantalla, todas las cards en historial, "PRECIO EFECTIVO" en el PDF).
- Presupuestos viejos sin `formaPagoSeleccionadaId` (NULL) ⇒ "Todas".

---

### Task 1: Backend — exponer `formaPagoSeleccionadaId` + header de PDF con jerarquía

**Files:**
- Modify: `showroom-backend/src/main/java/ar/com/leo/showroom/presupuesto/dto/PresupuestoDetalleDTO.java` (nuevo componente)
- Modify: `showroom-backend/src/main/java/ar/com/leo/showroom/presupuesto/service/PresupuestoComercialService.java` (mapeo en `obtenerDetalle` ~295-309)
- Modify: `showroom-backend/src/main/java/ar/com/leo/showroom/presupuesto/service/PresupuestoComercialPdfGenerator.java` (header de precio en `agregarTablaDetalle` ~1082; helper nuevo junto a `celdaHeader` ~2003)
- Modify: `showroom-frontend/src/app/showroom/models.ts` (`PresupuestoDetalle` ~865-908)

**Interfaces:**
- Produces: `PresupuestoDetalleDTO.formaPagoSeleccionadaId()` → `Long` (último componente del record); `PresupuestoDetalle.formaPagoSeleccionadaId?: number | null` (TS). Consumidos por Tasks 4 y 5.

- [ ] **Step 1: Agregar el componente al record `PresupuestoDetalleDTO`**

En `PresupuestoDetalleDTO.java`, agregar como ÚLTIMO componente del record (tras `formasPago`):

```java
        List<GenerarPresupuestoRequestDTO.Item> items,
        List<GenerarPresupuestoRequestDTO.FormaPagoSnapshot> formasPago,
        /** Id de la forma de pago elegida para el PDF agregado (null = "Todas").
         *  Permite que la pantalla de edición la pre-seleccione y que el
         *  historial muestre solo esa forma. */
        Long formaPagoSeleccionadaId
) {}
```

- [ ] **Step 2: Mapear el campo en `obtenerDetalle`**

En `PresupuestoComercialService.obtenerDetalle` (~295-309), agregar el argumento final al `new PresupuestoDetalleDTO(...)`:

```java
        return new PresupuestoDetalleDTO(
                p.getId(),
                p.getCreadoAt(),
                p.getModificadoAt(),
                p.getClienteNombre(),
                p.getClienteTelefono(),
                p.getClienteEmail(),
                p.getRubro(),
                p.getObservaciones(),
                p.getDescuentoGlobalPorcentaje(),
                datos.cotizacionIndividual(),
                p.getConvertidoEnPedidoId(),
                p.getConvertidoAt(),
                datos.items(),
                datos.formasPago(),
                p.getFormaPagoSeleccionadaId());
```

- [ ] **Step 3: Agregar un helper de celda de header de precio con jerarquía**

En `PresupuestoComercialPdfGenerator.java`, junto al método `celdaHeader` (~2003), agregar:

```java
    /** Celda del header de la columna de precio. Sin forma elegida es el
     *  header simple ("PRECIO EFECTIVO"). Con forma elegida, da jerarquía:
     *  "PRECIO" como título + el nombre de la forma como subtítulo más chico y
     *  gris, para que un nombre largo no se amontone en varias líneas iguales. */
    private static Cell celdaHeaderPrecio(GenerarPresupuestoRequestDTO.FormaPagoSnapshot formaElegida) {
        if (formaElegida == null) {
            return celdaHeader("PRECIO EFECTIVO").setTextAlignment(TextAlignment.RIGHT);
        }
        Cell c = new Cell()
                .setBorder(Border.NO_BORDER)
                .setBorderBottom(new SolidBorder(GRIS_LINEA, 1f))
                .setPadding(6)
                .setTextAlignment(TextAlignment.RIGHT);
        c.add(new Paragraph("PRECIO")
                .setFontSize(8)
                .setCharacterSpacing(1.5f)
                .setFontColor(GRIS_MEDIO)
                .simulateBold()
                .setMargin(0));
        c.add(new Paragraph(formaElegida.nombre())
                .setFontSize(6.5f)
                .setCharacterSpacing(0.3f)
                .setFontColor(GRIS_MEDIO)
                .setMarginTop(1f)
                .setMargin(0));
        return c;
    }
```

- [ ] **Step 4: Usar el helper en `agregarTablaDetalle`**

Reemplazar la línea del header de precio (~1082):

```java
        tabla.addHeaderCell(celdaHeader(etiquetaColumnaPrecio(formaElegida)).setTextAlignment(TextAlignment.RIGHT));
```

por:

```java
        tabla.addHeaderCell(celdaHeaderPrecio(formaElegida));
```

(`etiquetaColumnaPrecio` sigue usándose en otros lados — no se elimina.)

- [ ] **Step 5: Agregar el campo al modelo TS `PresupuestoDetalle`**

En `showroom-frontend/src/app/showroom/models.ts`, dentro de `PresupuestoDetalle` (tras `cotizacionIndividual: boolean | null;`):

```typescript
  /** Id de la forma de pago elegida (null = "Todas"). Lo usa la edición para
   *  pre-seleccionar el dropdown y el historial para mostrar solo esa forma. */
  formaPagoSeleccionadaId?: number | null;
```

- [ ] **Step 6: Compilar backend + suite + frontend**

Run: `mvn -f showroom-backend/pom.xml test 2>&1 | grep -E "Tests run: [0-9]+, Failures.*Skipped: [0-9]+$|BUILD"`
Expected: `BUILD SUCCESS`, 0 failures.
Run: `cd showroom-frontend && npm run build`
Expected: build OK.

- [ ] **Step 7: Commit**

```bash
git add showroom-backend/src/main/java/ar/com/leo/showroom/presupuesto/dto/PresupuestoDetalleDTO.java \
        showroom-backend/src/main/java/ar/com/leo/showroom/presupuesto/service/PresupuestoComercialService.java \
        showroom-backend/src/main/java/ar/com/leo/showroom/presupuesto/service/PresupuestoComercialPdfGenerator.java \
        showroom-frontend/src/app/showroom/models.ts
git commit -m "feat(presupuesto): exponer formaPagoSeleccionadaId en el detalle + header de PDF con jerarquía"
```

---

### Task 2: Selector — label pegado al input + íconos por forma

**Files:**
- Modify: `showroom-frontend/src/app/showroom/presupuestos-page/presupuestos-page.html` (bloque del selector ~440-456)
- Modify: `showroom-frontend/src/app/showroom/presupuestos-page/presupuestos-page.ts` (import + helper `iconoForma`)

**Interfaces:**
- Consumes: `formasPago()`, `formaPagoSeleccionadaId` (existentes); `iconoFormaReferencia` de `precio-referencia.util.ts`.
- Produces: `iconoForma(nombre)` helper. La opción "Todas" se mantiene vía `[showClear]` + placeholder.

- [ ] **Step 1: Importar el helper de íconos y exponerlo**

En `presupuestos-page.ts`, agregar `iconoFormaReferencia` al import desde `'../precio-referencia.util'` (donde ya se importa `precioPorForma`). Luego dentro de la clase, junto a los otros helpers (cerca de `perfilForma`, ~386):

```typescript
  /** Ícono PrimeNG para una forma de pago (mismo criterio que el showroom). */
  iconoForma(nombre: string | null | undefined): string {
    return iconoFormaReferencia(nombre);
  }
```

- [ ] **Step 2: Agrupar label + dropdown y agregar los íconos (HTML)**

En `presupuestos-page.html`, reemplazar el bloque del selector de forma de pago (el `@if (!cotizacionIndividual())` con el `<span>` "Forma de pago" + el `<p-select>`):

```html
            @if (!cotizacionIndividual()) {
              <span class="text-xs font-bold uppercase tracking-wider text-[#3B1E09] dark:text-surface-0 flex items-center gap-1.5">
                <i class="pi pi-wallet text-[#FF861C]"></i>
                Forma de pago
              </span>
              <p-select
                [options]="formasPago()"
                [ngModel]="formaPagoSeleccionadaId()"
                (ngModelChange)="formaPagoSeleccionadaId.set($event)"
                optionLabel="nombre" optionValue="id"
                [showClear]="true"
                placeholder="Todas"
                class="kt-forma-pago-pdf text-sm" />
            }
```

por (envuelve el label y el select en un único `<div>` inline-flex que no se separa, y agrega los templates con ícono):

```html
            @if (!cotizacionIndividual()) {
              <div class="inline-flex items-center gap-1.5">
                <span class="text-xs font-bold uppercase tracking-wider text-[#3B1E09] dark:text-surface-0 flex items-center gap-1.5 shrink-0">
                  <i class="pi pi-wallet text-[#FF861C]"></i>
                  Forma de pago
                </span>
                <p-select
                  [options]="formasPago()"
                  [ngModel]="formaPagoSeleccionadaId()"
                  (ngModelChange)="formaPagoSeleccionadaId.set($event)"
                  optionLabel="nombre" optionValue="id"
                  [showClear]="true"
                  placeholder="Todas"
                  appendTo="body"
                  class="kt-forma-pago-pdf text-sm">
                  <ng-template let-fp #selectedItem>
                    <span class="inline-flex items-center gap-2">
                      <i [class]="iconoForma(fp.nombre)" class="text-[#FF861C]"></i>
                      {{ fp.nombre }}
                    </span>
                  </ng-template>
                  <ng-template let-fp #item>
                    <span class="inline-flex items-center gap-2">
                      <i [class]="iconoForma(fp.nombre)" class="text-[#FF861C]"></i>
                      {{ fp.nombre }}
                    </span>
                  </ng-template>
                </p-select>
              </div>
            }
```

(Con `optionValue="id"`, los templates `#selectedItem`/`#item` reciben el objeto forma completo — `fp.nombre` es válido. `appendTo="body"` evita que el overlay quede recortado por la toolbar, igual que el showroom.)

- [ ] **Step 3: Verificar el build**

Run: `cd showroom-frontend && npm run build`
Expected: build OK.

- [ ] **Step 4: Verificación manual (humano)**

En `/presupuestos` (modo Agregado): el label "Forma de pago" queda pegado a su dropdown aunque la toolbar se angoste; el dropdown muestra el ícono de cada forma (Efectivo billete, Transferencia flechas, cuotas tarjeta) tanto en la lista como en el valor seleccionado.

- [ ] **Step 5: Commit**

```bash
git add showroom-frontend/src/app/showroom/presupuestos-page/presupuestos-page.html \
        showroom-frontend/src/app/showroom/presupuestos-page/presupuestos-page.ts
git commit -m "feat(presupuestos): selector de forma de pago con label pegado e íconos por forma"
```

---

### Task 3: Precio en vivo por forma en la pantalla

**Files:**
- Modify: `showroom-frontend/src/app/showroom/presupuestos-page/presupuestos-page.ts` (getters/computeds nuevos)
- Modify: `showroom-frontend/src/app/showroom/presupuestos-page/presupuestos-page.html` (tabla ~639, footer ~790-799, resumen dialog ~1028)

**Interfaces:**
- Consumes: `formaPagoSeleccionadaId`, `formasPago()`, `precioMostrado(it)`, `perfilForma`, `rubroCotizaSinIva`, `precioPorForma`, `items()`, `itemsTick()` (todos existentes).
- Produces: `formaPagoSeleccionada()`, `precioVisualItem(it)`, `subtotalVisual()`, `totalVisual()`, `descuentoVisualMonto()`.

- [ ] **Step 1: Agregar los getters/computeds visuales**

En `presupuestos-page.ts`, después de `precioMostrado(...)` (~1485), agregar:

```typescript
  /** Objeto de la forma de pago elegida (null = "Todas"). */
  readonly formaPagoSeleccionada = computed<FormaPago | null>(() => {
    const id = this.formaPagoSeleccionadaId();
    if (id == null) return null;
    return this.formasPago().find((f) => f.id === id) ?? null;
  });

  /** Precio unitario a MOSTRAR según la forma elegida; con "Todas" cae al
   *  precio Efectivo (referencia). Solo visual — el payload sigue usando
   *  `precioMostrado` (Efectivo). */
  precioVisualItem(it: {
    pvpKtGastroConIva: number | null;
    pvpKtGastroSinIva: number | null;
    porcIva?: number | null;
    rubro?: string | null;
  }): number {
    const forma = this.formaPagoSeleccionada();
    if (!forma) return this.precioMostrado(it);
    const perfil = this.perfilForma(forma, this.rubroCotizaSinIva(it.rubro));
    return precioPorForma(it.pvpKtGastroConIva, it.porcIva ?? null, perfil);
  }
```

Y junto a `subtotalReferencia` (~534), agregar los computeds visuales:

```typescript
  /** Subtotal BRUTO en la forma elegida (sin descuentos individuales). Con
   *  "Todas" coincide con `subtotalReferencia`. */
  readonly subtotalVisual = computed(() => {
    this.itemsTick();
    return this.items().reduce((acc, it) => acc + this.precioVisualItem(it) * it.cantidad, 0);
  });

  /** Total NETO en la forma elegida (con los descuentos individuales). Con
   *  "Todas" coincide con `totalReferencia`. */
  readonly totalVisual = computed(() => {
    this.itemsTick();
    return this.items().reduce(
      (acc, it) => acc + this.precioVisualItem(it) * it.cantidad * (1 - (it.descuentoPorcentaje ?? 0) / 100),
      0,
    );
  });

  /** Ahorro por descuentos individuales en la forma elegida (bruto − neto). */
  readonly descuentoVisualMonto = computed(() => this.subtotalVisual() - this.totalVisual());
```

- [ ] **Step 2: Usar el precio visual en la tabla (HTML ~639)**

Reemplazar:

```html
                        {{ precioMostrado(it) | currency:'ARS':'symbol':'1.0-0' }}
```

por:

```html
                        {{ precioVisualItem(it) | currency:'ARS':'symbol':'1.0-0' }}
```

- [ ] **Step 3: Usar el total/subtotal visual en el footer (HTML ~789-799)**

Reemplazar el bloque:

```html
              <span class="text-xl sm:text-2xl font-bold text-[#3B1E09] dark:text-surface-0">
                {{ totalReferencia() | currency:'ARS':'symbol':'1.0-0' }}
              </span>
              @if (descuentoTotalMonto() > 0) {
                <span class="text-[11px] text-muted-color line-through">
                  {{ subtotalReferencia() | currency:'ARS':'symbol':'1.0-0' }}
                </span>
                <span class="text-[11px] text-emerald-600 dark:text-emerald-400 font-semibold">
                  −{{ descuentoTotalMonto() | currency:'ARS':'symbol':'1.0-0' }}
                </span>
              }
```

por:

```html
              <span class="text-xl sm:text-2xl font-bold text-[#3B1E09] dark:text-surface-0">
                {{ totalVisual() | currency:'ARS':'symbol':'1.0-0' }}
              </span>
              @if (descuentoVisualMonto() > 0) {
                <span class="text-[11px] text-muted-color line-through">
                  {{ subtotalVisual() | currency:'ARS':'symbol':'1.0-0' }}
                </span>
                <span class="text-[11px] text-emerald-600 dark:text-emerald-400 font-semibold">
                  −{{ descuentoVisualMonto() | currency:'ARS':'symbol':'1.0-0' }}
                </span>
              }
```

- [ ] **Step 4: Usar el total visual en el resumen del dialog (HTML ~1028)**

Reemplazar:

```html
            {{ totalReferencia() | currency:'ARS':'symbol':'1.0-0' }}
```

(dentro del bloque `@if (accionPendienteDialog() !== null)`, el "Total" del resumen) por:

```html
            {{ totalVisual() | currency:'ARS':'symbol':'1.0-0' }}
```

- [ ] **Step 5: Verificar el build**

Run: `cd showroom-frontend && npm run build`
Expected: build OK.

- [ ] **Step 6: Verificación manual (humano)**

En `/presupuestos` con ítems: con "Todas", los precios y total son Efectivo (como hoy). Al elegir una forma con recargo, cada precio de la tabla y el total suben a esa forma; el tachado/ahorro se recalculan. El PDF sigue saliendo correcto y el footer de chips sigue mostrando todas las formas.

- [ ] **Step 7: Commit**

```bash
git add showroom-frontend/src/app/showroom/presupuestos-page/presupuestos-page.ts \
        showroom-frontend/src/app/showroom/presupuestos-page/presupuestos-page.html
git commit -m "feat(presupuestos): precio por ítem y total en vivo según la forma elegida"
```

---

### Task 4: Historial — mostrar solo la forma elegida

**Files:**
- Modify: `showroom-frontend/src/app/showroom/presupuestos-historial-page/presupuestos-historial-page.ts` (imports + métodos)
- Modify: `showroom-frontend/src/app/showroom/presupuestos-historial-page/presupuestos-historial-page.html` (sección formas ~382-409; total presupuesto; precio por ítem)

**Interfaces:**
- Consumes: `PresupuestoDetalle.formaPagoSeleccionadaId` (Task 1); `precioPorForma`, `perfilForma` de `precio-referencia.util.ts`; `PrecioPerfilService.rubroCotizaSinIva`.
- Produces: `formaSeleccionadaDe(det)`, `formasAMostrar(det)`, precio/total ajustados por forma.

- [ ] **Step 1: Importar utilidades y (si falta) el servicio de perfil**

En `presupuestos-historial-page.ts`, agregar a los imports:

```typescript
import { perfilForma, precioPorForma } from '../precio-referencia.util';
import { PrecioPerfilService } from '../precio-perfil.service';
```

Y en la clase, si aún no está inyectado, agregar el servicio (junto a los otros `inject(...)`):

```typescript
  private readonly precioPerfil = inject(PrecioPerfilService);
```

(Si ya estuviera inyectado, no duplicar.)

- [ ] **Step 2: Agregar la resolución de la forma elegida y las formas a mostrar**

En `presupuestos-historial-page.ts`, junto a `formasGlobales` (~490), agregar:

```typescript
  /** La forma de pago elegida del presupuesto (null = "Todas"), buscada entre
   *  las formas globales por el id persistido. */
  formaSeleccionadaDe(det: PresupuestoDetalle): PresupuestoFormaPagoSnapshot | null {
    const id = det.formaPagoSeleccionadaId;
    if (id == null) return null;
    return this.formasGlobales(det).find((f) => f.id === id) ?? null;
  }

  /** Formas a mostrar en el panel: si hay una elegida, solo esa; si no, todas
   *  las globales (comportamiento histórico). */
  formasAMostrar(det: PresupuestoDetalle): PresupuestoFormaPagoSnapshot[] {
    const elegida = this.formaSeleccionadaDe(det);
    return elegida ? [elegida] : this.formasGlobales(det);
  }
```

- [ ] **Step 3: Ajustar precio/subtotal/total por la forma elegida**

En `presupuestos-historial-page.ts`, reemplazar `precioItem`, `subtotalItem` y `totalPresupuesto` para que, cuando hay forma elegida, usen esa forma (recalculada con el perfil del rubro); sin forma, el comportamiento actual (Efectivo).

Reemplazar `precioItem` (~457):

```typescript
  /** Precio unitario a mostrar para un ítem en el detalle: en la forma elegida
   *  del presupuesto si hay una, o el de referencia (Efectivo) si no. */
  precioItem(
    it: { precioReferencia?: number | null; precioConIva: number; porcIva?: number | null; rubro?: string | null },
    det?: PresupuestoDetalle,
  ): number {
    const elegida = det ? this.formaSeleccionadaDe(det) : null;
    if (elegida) {
      const perfil = perfilForma(elegida, this.precioPerfil.rubroCotizaSinIva(it.rubro));
      return precioPorForma(it.precioConIva, it.porcIva ?? null, perfil);
    }
    return it.precioReferencia ?? it.precioConIva;
  }
```

Reemplazar `subtotalItem` (~470) para propagar `det`:

```typescript
  /** Subtotal de la línea = precio (en la forma elegida o Efectivo) × cantidad ×
   *  (1 − desc/100). */
  subtotalItem(
    it: {
      precioReferencia?: number | null;
      precioConIva: number;
      porcIva?: number | null;
      rubro?: string | null;
      cantidad: number;
      descuentoPorcentaje: number | null;
    },
    det?: PresupuestoDetalle,
  ): number {
    return this.precioItem(it, det) * it.cantidad * (1 - (it.descuentoPorcentaje ?? 0) / 100);
  }
```

Reemplazar `totalPresupuesto` (~481):

```typescript
  /** Total del presupuesto: si hay forma elegida, su `precioFinal` (snapshot ya
   *  calculado); si no, la suma de los subtotales de referencia (Efectivo). */
  totalPresupuesto(det: PresupuestoDetalle): number {
    const elegida = this.formaSeleccionadaDe(det);
    if (elegida) return elegida.precioFinal ?? 0;
    return det.items.reduce((s, it) => s + this.subtotalItem(it), 0);
  }
```

- [ ] **Step 4: Ajustar el HTML del detalle**

En `presupuestos-historial-page.html`:

(a) La sección de cards de formas: cambiar el `@for` de `formasGlobales(det)` a `formasAMostrar(det)`, y la guarda `@else if (formasGlobales(det).length)` a `formasAMostrar(det).length`. Reemplazar:

```html
} @else if (formasGlobales(det).length) {
```
por:
```html
} @else if (formasAMostrar(det).length) {
```
y dentro:
```html
      @for (fp of formasGlobales(det); track fp.id ?? fp.nombre) {
```
por:
```html
      @for (fp of formasAMostrar(det); track fp.id ?? fp.nombre) {
```

(b) En el `@for` de ítems del detalle, pasar `det` a las dos llamadas (el `det` del row-expansion está en scope — lo usa también `totalPresupuesto(det)` en la línea ~314).

Línea ~362, reemplazar:
```html
                            {{ precioItem(it) | currency:'ARS':'symbol':'1.0-0' }}
```
por:
```html
                            {{ precioItem(it, det) | currency:'ARS':'symbol':'1.0-0' }}
```

Línea ~375, reemplazar:
```html
                            {{ subtotalItem(it) | currency:'ARS':'symbol':'1.0-0' }}
```
por:
```html
                            {{ subtotalItem(it, det) | currency:'ARS':'symbol':'1.0-0' }}
```

El `ivaItem(it)` (badge c/IVA/s/IVA, línea ~363) se deja como está — sigue reflejando el régimen del producto.

(El "Total presupuesto" del header del detalle ya llama `totalPresupuesto(det)`, que ahora devuelve el total de la forma — no requiere cambio de HTML.)

- [ ] **Step 5: Verificar el build**

Run: `cd showroom-frontend && npm run build`
Expected: build OK.

- [ ] **Step 6: Verificación manual (humano)**

En `/presupuestos/historial`, expandir: un presupuesto con forma elegida muestra solo esa card, y el "Total presupuesto" + precios por ítem en esa forma; uno sin forma (o viejo) muestra Efectivo + todas las cards, como hoy. Un presupuesto de cotización individual no cambia (sigue el aviso).

- [ ] **Step 7: Commit**

```bash
git add showroom-frontend/src/app/showroom/presupuestos-historial-page/presupuestos-historial-page.ts \
        showroom-frontend/src/app/showroom/presupuestos-historial-page/presupuestos-historial-page.html
git commit -m "feat(presupuestos-historial): mostrar solo la forma elegida y su total/precios"
```

---

### Task 5: Ajustes finales — hidratar edición, nombre obligatorio, footer sin truncar

**Files:**
- Modify: `showroom-frontend/src/app/showroom/presupuestos-page/presupuestos-page.ts` (`cargarParaEditar` ~899; `validarDatosCliente` ~2094)
- Modify: `showroom-frontend/src/app/showroom/presupuestos-page/presupuestos-page.html` (label nombre ~947)
- Modify: `showroom-frontend/src/app/showroom/presupuestos-page/presupuestos-page.scss` (`.kt-footer-chips` ~508, `.kt-forma-chip-nombre` ~543)

**Interfaces:**
- Consumes: `PresupuestoDetalle.formaPagoSeleccionadaId` (Task 1); `formaPagoSeleccionadaId`, `clienteNombre`, `warn` (existentes).

- [ ] **Step 1: Hidratar la forma elegida al editar**

En `presupuestos-page.ts`, en `cargarParaEditar`, después de `this.cotizacionIndividual.set(Boolean(det.cotizacionIndividual));` (~899), agregar:

```typescript
        // Forma de pago elegida del PDF agregado — pre-selecciona el dropdown.
        this.formaPagoSeleccionadaId.set(det.formaPagoSeleccionadaId ?? null);
```

- [ ] **Step 2: Nombre del cliente obligatorio (validación)**

En `presupuestos-page.ts`, en `validarDatosCliente` (~2094), agregar la validación del nombre antes del `return true`:

```typescript
    const nombre = this.clienteNombre().trim();
    if (!nombre) {
      this.warn('Falta el nombre del cliente.');
      return false;
    }
    return true;
```

(Queda: valida email-formato, luego teléfono, luego nombre.)

- [ ] **Step 3: Asterisco en el label del nombre (HTML ~947)**

Reemplazar:

```html
      <label for="dlgNombreInput" class="kt-label">
        <i class="pi pi-id-card"></i> Nombre del cliente
      </label>
```

por:

```html
      <label for="dlgNombreInput" class="kt-label">
        <i class="pi pi-id-card"></i> Nombre del cliente <span class="text-red-500">*</span>
      </label>
```

- [ ] **Step 4: Footer de chips — mostrar nombres completos (SCSS)**

En `presupuestos-page.scss`, en `.kt-footer-chips` (~508), permitir wrap y quitar el clip:

```scss
.kt-footer-chips {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  flex: 1 1 auto;
  min-width: 0;
  justify-content: flex-end;
  flex-wrap: wrap;
  row-gap: 0.3rem;
}
```

(Se quitó `overflow: hidden` y se agregó `flex-wrap: wrap` + `row-gap`.)

Y en `.kt-forma-chip .kt-forma-chip-nombre` (~543), quitar el truncado para que el nombre se vea completo:

```scss
  // Nombre de la forma: se muestra completo (los chips ahora envuelven a otra
  // fila si no entran, en lugar de recortar con elipsis).
  .kt-forma-chip-nombre {
    white-space: nowrap;
  }
```

Además, para que el chip no se siga encogiendo y recortando visualmente, en `:host ::ng-deep .kt-forma-chip` (~520) cambiar `flex: 0 1 auto;` por `flex: 0 0 auto;`:

```scss
  flex: 0 0 auto; // no se encoge: el nombre entra completo, los chips envuelven
```

- [ ] **Step 5: Verificar el build**

Run: `cd showroom-frontend && npm run build`
Expected: build OK.

- [ ] **Step 6: Verificación manual (humano)**

- Editar un presupuesto que tenía forma elegida → el dropdown viene con esa forma; guardar la conserva.
- En el modal, intentar Guardar/Generar sin nombre → aviso "Falta el nombre del cliente"; con nombre y teléfono procede.
- El footer de formas muestra los nombres completos (envuelven a otra fila si hace falta) en lugar de "Ef…", "Transferen…".

- [ ] **Step 7: Commit**

```bash
git add showroom-frontend/src/app/showroom/presupuestos-page/presupuestos-page.ts \
        showroom-frontend/src/app/showroom/presupuestos-page/presupuestos-page.html \
        showroom-frontend/src/app/showroom/presupuestos-page/presupuestos-page.scss
git commit -m "feat(presupuestos): hidratar forma al editar, nombre obligatorio y footer de chips sin truncar"
```

---

## Notas de verificación final (tras todas las tareas)

- Backend: `mvn -f showroom-backend/pom.xml test` en verde.
- Frontend: `cd showroom-frontend && npm run build` OK.
- "Todas": pantalla, historial y PDF idénticos al comportamiento previo.
- Forma elegida: precios/total en vivo en la pantalla; PDF con header jerárquico; historial con solo esa card y total/precios en esa forma; el dropdown viene marcado al editar.
- Modal: no se puede confirmar sin nombre ni sin teléfono.
- Footer: nombres de formas completos.
- El dato persistido (precioReferencia/subtotalSinIva) sigue siendo Efectivo — el flujo de pedido no cambia.
