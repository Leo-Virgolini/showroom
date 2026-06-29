# Marcador de maquinaria al criterio configurable — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que el marcador visual `esRubroMaquinaria` use el criterio configurable `PrecioPerfilService.rubroCotizaSinIva` en los 6 componentes, y eliminar el hardcoded `rubroExcluyeDescuentos`/`RUBROS_SIN_DESCUENTO_ESCALA` de `models.ts`.

**Architecture:** Cada componente reemplaza el alias `esRubroMaquinaria = rubroExcluyeDescuentos` (función pura hardcoded) por un método que delega en `this.precioPerfil.rubroCotizaSinIva(rubro)` (lista configurable cargada del backend). `productos-page` y `pedidos-page` inyectan el servicio; los que no llaman `cargar()` lo agregan. Luego se borra la lista/función hardcoded de `models.ts`.

**Tech Stack:** Angular 21 (signals, inject). Verificación: `cd showroom-frontend && npm run build`.

## Global Constraints

- Solo cambia el marcado VISUAL (badges/resaltado). El cálculo de descuentos por escala y la facturación ya usan `rubroCotizaSinIva` — no se tocan.
- El método uniforme en todos los componentes:
  ```typescript
  esRubroMaquinaria(rubro: string | null | undefined): boolean {
    return this.precioPerfil.rubroCotizaSinIva(rubro);
  }
  ```
- El template sigue llamando `esRubroMaquinaria(...)` — sin cambios de HTML.
- Cada componente que dependa de la lista debe llamar `this.precioPerfil.cargar()` al entrar (en el constructor), siguiendo el patrón existente (`showroom-page.ts:861`).
- `cotizador-page` no usa el marcador — no se toca. `normalizarRubro` se mantiene en `models.ts`.

---

### Task 1: Migrar los 6 componentes al criterio configurable

**Files:**
- Modify: `showroom-frontend/src/app/showroom/showroom-page/showroom-page.ts` (alias 642; import 40)
- Modify: `showroom-frontend/src/app/showroom/presupuestos-page/presupuestos-page.ts` (alias 1498; import 48; comentario 1611)
- Modify: `showroom-frontend/src/app/showroom/historial-page/historial-page.ts` (alias 444; import 38)
- Modify: `showroom-frontend/src/app/showroom/presupuestos-historial-page/presupuestos-historial-page.ts` (alias 79; import 26; constructor 131)
- Modify: `showroom-frontend/src/app/showroom/productos-page/productos-page.ts` (alias 250; import 28; constructor 113; inyectar servicio)
- Modify: `showroom-frontend/src/app/showroom/pedidos-page/pedidos-page.ts` (alias 500; import 35; constructor 138; inyectar servicio)

**Interfaces:**
- Consumes: `PrecioPerfilService.rubroCotizaSinIva(rubro: string | null | undefined): boolean` y `cargar(): void` (existentes).
- Produces: `esRubroMaquinaria(rubro)` como método (en vez de alias) en los 6 componentes.

- [ ] **Step 1: showroom-page — alias → método + quitar import**

En `showroom-page.ts`, reemplazar el alias (642) y su comentario:

```typescript
  /** True si el ítem es de maquinaria (`MAQUINAS INDUSTRIALES`) — el template
   *  muestra el badge "MÁQUINA INDUSTRIAL" en la fila. Criterio único
   *  (`rubroExcluyeDescuentos`) compartido por todas las tablas de la app. */
  protected readonly esRubroMaquinaria = rubroExcluyeDescuentos;
```

por:

```typescript
  /** True si el ítem es de maquinaria (rubro de la lista configurable que cotiza
   *  sin IVA) — el template muestra el badge "MÁQUINA INDUSTRIAL". Mismo criterio
   *  configurable que el cálculo y el backend. */
  esRubroMaquinaria(rubro: string | null | undefined): boolean {
    return this.precioPerfil.rubroCotizaSinIva(rubro);
  }
```

Y en el import (40), quitar `rubroExcluyeDescuentos, `:

```typescript
import { CarritoItem, CatalogoItem, EscalaDescuento, FormaPago, ScanResult } from '../models';
```

(showroom-page ya inyecta `precioPerfil` y ya llama `cargar()` en :861 — sin cambios.)

- [ ] **Step 2: presupuestos-page — alias → método + quitar import + comentario**

En `presupuestos-page.ts`, reemplazar el alias (1498) y su comentario:

```typescript
  /** True si el producto es de maquinaria (`MAQUINAS INDUSTRIALES`) — marca las
   *  filas con un badge/resaltado. Criterio único (`rubroExcluyeDescuentos`)
   *  compartido por todas las tablas de la app. */
  protected readonly esRubroMaquinaria = rubroExcluyeDescuentos;
```

por:

```typescript
  /** True si el producto es de maquinaria (rubro de la lista configurable que
   *  cotiza sin IVA) — marca las filas con un badge/resaltado. Mismo criterio
   *  configurable que el cálculo y el backend. */
  esRubroMaquinaria(rubro: string | null | undefined): boolean {
    return this.precioPerfil.rubroCotizaSinIva(rubro);
  }
```

En el import (bloque multilínea, línea 48), quitar la línea `  rubroExcluyeDescuentos,`.

Si el comentario en ~1611 referencia `rubroExcluyeDescuentos` (ej. "eso hace que la helper `rubroExcluyeDescuentos` lo…"), reemplazar esa mención por `rubroCotizaSinIva` para que no quede colgada. (presupuestos-page ya inyecta `precioPerfil` y llama `cargar()` en :735 — sin cambios.)

- [ ] **Step 3: historial-page — alias → método + quitar import**

En `historial-page.ts`, reemplazar el alias (444):

```typescript
  protected readonly esRubroMaquinaria = rubroExcluyeDescuentos;
```

por:

```typescript
  esRubroMaquinaria(rubro: string | null | undefined): boolean {
    return this.precioPerfil.rubroCotizaSinIva(rubro);
  }
```

(Conservar el comentario JSDoc anterior si lo tiene, o anteponer uno breve.) En el import (bloque multilínea, línea 38) quitar la línea `  rubroExcluyeDescuentos,`. (Ya inyecta `precioPerfil` y llama `cargar()` en :239.)

- [ ] **Step 4: presupuestos-historial-page — alias → método + quitar import + cargar()**

En `presupuestos-historial-page.ts`, reemplazar el alias (79):

```typescript
  protected readonly esRubroMaquinaria = rubroExcluyeDescuentos;
```

por:

```typescript
  esRubroMaquinaria(rubro: string | null | undefined): boolean {
    return this.precioPerfil.rubroCotizaSinIva(rubro);
  }
```

En el import (línea 26), quitar `rubroExcluyeDescuentos` (es de una sola línea):

```typescript
import { PresupuestoDetalle, PresupuestoFormaPagoSnapshot, PresupuestoListItem } from '../models';
```

Y como NO llama `cargar()`, agregarlo al inicio del `constructor()` (línea 131), después de `constructor() {`:

```typescript
  constructor() {
    // Carga la lista de rubros sin IVA (perfil maquinaria) para el marcador.
    this.precioPerfil.cargar();
```

- [ ] **Step 5: productos-page — inyectar servicio + alias → método + quitar import + cargar()**

En `productos-page.ts`:

(a) Agregar el import del servicio (junto a los otros imports de `from '..'`):

```typescript
import { PrecioPerfilService } from '../precio-perfil.service';
```

(b) Inyectar (junto a los otros `inject(...)`, p. ej. tras `private readonly toast = inject(...)`):

```typescript
  private readonly precioPerfil = inject(PrecioPerfilService);
```

(c) Reemplazar el alias (250) y su comentario:

```typescript
  /** True si el producto es de maquinaria (`MAQUINAS INDUSTRIALES`) — marca la
   *  fila con un badge ámbar. Criterio único (`rubroExcluyeDescuentos`)
   *  compartido por todas las tablas de la app. */
  protected readonly esRubroMaquinaria = rubroExcluyeDescuentos;
```

por:

```typescript
  /** True si el producto es de maquinaria (rubro de la lista configurable que
   *  cotiza sin IVA) — marca la fila con un badge ámbar. Mismo criterio
   *  configurable que el cálculo y el backend. */
  esRubroMaquinaria(rubro: string | null | undefined): boolean {
    return this.precioPerfil.rubroCotizaSinIva(rubro);
  }
```

(d) En el import (28), quitar `rubroExcluyeDescuentos`:

```typescript
import { ProductoListItem } from '../models';
```

(e) Agregar la carga al inicio del `constructor()` (línea 113), tras `constructor() {`:

```typescript
  constructor() {
    // Carga la lista de rubros sin IVA (perfil maquinaria) para el marcador.
    this.precioPerfil.cargar();
```

- [ ] **Step 6: pedidos-page — inyectar servicio + alias → método + quitar import + cargar()**

En `pedidos-page.ts`:

(a) Agregar el import del servicio:

```typescript
import { PrecioPerfilService } from '../precio-perfil.service';
```

(b) Inyectar (junto a los otros `inject(...)`):

```typescript
  private readonly precioPerfil = inject(PrecioPerfilService);
```

(c) Reemplazar el alias (500):

```typescript
  protected readonly esRubroMaquinaria = rubroExcluyeDescuentos;
```

por:

```typescript
  esRubroMaquinaria(rubro: string | null | undefined): boolean {
    return this.precioPerfil.rubroCotizaSinIva(rubro);
  }
```

(d) En el import (bloque multilínea, línea 35), quitar la línea `  rubroExcluyeDescuentos,`.

(e) Agregar la carga al inicio del `constructor()` (línea 138), tras `constructor() {`:

```typescript
  constructor() {
    // Carga la lista de rubros sin IVA (perfil maquinaria) para el marcador.
    this.precioPerfil.cargar();
```

- [ ] **Step 7: Verificar el build**

Run: `cd showroom-frontend && npm run build`
Expected: build OK. (En este punto `rubroExcluyeDescuentos`/`RUBROS_SIN_DESCUENTO_ESCALA` siguen definidos en `models.ts` pero ya sin uso — eso no rompe; Task 2 los elimina.)

- [ ] **Step 8: Confirmar que no quedan usos del hardcoded**

Run: `grep -rn "rubroExcluyeDescuentos\|RUBROS_SIN_DESCUENTO_ESCALA" showroom-frontend/src/app --include=*.ts | grep -v node_modules | grep -v "models.ts"`
Expected: 0 resultados (solo deberían quedar las definiciones en models.ts, que Task 2 elimina).

- [ ] **Step 9: Commit**

```bash
git add showroom-frontend/src/app/showroom/showroom-page/showroom-page.ts \
        showroom-frontend/src/app/showroom/presupuestos-page/presupuestos-page.ts \
        showroom-frontend/src/app/showroom/historial-page/historial-page.ts \
        showroom-frontend/src/app/showroom/presupuestos-historial-page/presupuestos-historial-page.ts \
        showroom-frontend/src/app/showroom/productos-page/productos-page.ts \
        showroom-frontend/src/app/showroom/pedidos-page/pedidos-page.ts
git commit -m "refactor(showroom): el marcador de maquinaria usa el criterio configurable (rubroCotizaSinIva)"
```

---

### Task 2: Eliminar el hardcoded de models.ts

**Files:**
- Modify: `showroom-frontend/src/app/showroom/models.ts` (`RUBROS_SIN_DESCUENTO_ESCALA` ~17-22, `rubroExcluyeDescuentos` ~24-30)

**Interfaces:**
- Consumes: nada (los 6 componentes ya no lo importan tras Task 1).

- [ ] **Step 1: Quitar la constante y la función hardcoded**

En `models.ts`, eliminar el bloque de `RUBROS_SIN_DESCUENTO_ESCALA` (con su comentario) y la función `rubroExcluyeDescuentos`:

```typescript
/** Nombre del rubro DUX que está excluido de los descuentos generales por
 *  escala. La comparación se hace case-insensitive y trimeada para tolerar
 *  variaciones de casing en DUX. Mantener sincronizado con la lista
 *  {@code RUBROS_SIN_DESCUENTO_ESCALA} del backend
 *  ({@code PresupuestoComercialPdfGenerator}). */
export const RUBROS_SIN_DESCUENTO_ESCALA = new Set(['MAQUINAS INDUSTRIALES']);

/** True si el rubro está excluido de los descuentos generales por escala.
 *  Tolera null/whitespace/casing/diacríticos — DUX a veces devuelve
 *  "Máquinas Industriales" con tilde o lowercase, lo aceptamos igual. */
export function rubroExcluyeDescuentos(rubro: string | null | undefined): boolean {
  const n = normalizarRubro(rubro);
  return n !== '' && RUBROS_SIN_DESCUENTO_ESCALA.has(n);
}
```

(Eliminar esas líneas por completo. `normalizarRubro`, `OPCIONES_RUBRO_CLIENTE` y el resto se mantienen.)

- [ ] **Step 2: Verificar el build y la ausencia total del hardcoded**

Run: `grep -rn "rubroExcluyeDescuentos\|RUBROS_SIN_DESCUENTO_ESCALA" showroom-frontend/src/app --include=*.ts | grep -v node_modules`
Expected: 0 resultados.
Run: `cd showroom-frontend && npm run build`
Expected: build OK.

- [ ] **Step 3: Verificación manual (humano)**

- El badge/resaltado de maquinaria sigue apareciendo para `MAQUINAS INDUSTRIALES` en productos, showroom, presupuestos, pedidos y los dos historiales.
- (La mejora) Agregar un rubro a "rubros sin IVA" en `/configuracion` → los ítems de ese rubro ahora también se marcan visualmente (antes no).

- [ ] **Step 4: Commit**

```bash
git add showroom-frontend/src/app/showroom/models.ts
git commit -m "refactor(showroom): eliminar la lista hardcoded de rubros sin descuento (ya configurable)"
```

---

## Notas de verificación final

- `cd showroom-frontend && npm run build` OK.
- `grep rubroExcluyeDescuentos|RUBROS_SIN_DESCUENTO_ESCALA` en el frontend → 0.
- Una sola fuente de verdad (la lista configurable de `/configuracion`) para el marcador, el cálculo y el backend.
- El cálculo de descuentos por escala y la facturación no cambian.
