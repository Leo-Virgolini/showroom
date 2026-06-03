# Precios de referencia en scan + visor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mostrar varios precios de referencia (Efectivo / Transferencia / Transferencia S/F) en el panel de scan, el visor y el carrito, reutilizando las formas de pago con un flag nuevo `precioReferencia` y recargos negativos como descuento.

**Architecture:** Las formas de pago marcadas con `precioReferencia=true` se muestran como precios de referencia, calculadas sobre `pvpKtGastroConIva`. Los descuentos se modelan con `recargoPorcentaje` negativo. El cálculo de display vive en una función pura compartida (`precio-referencia.util.ts`). El pedido a DUX NO cambia: el backend ya ignora recargos ≤ 0 (`signum() > 0`), así que sigue subiendo el precio lista.

**Tech Stack:** Spring Boot 4 / Java 25 (backend), Angular 21 + PrimeNG 21 + Tailwind v4 (frontend), Jasmine/Karma (`ng test`).

**Spec:** `docs/superpowers/specs/2026-06-03-precios-referencia-visor-design.md`

---

## Convenciones de nombres (consistentes en todo el plan)

- Backend: `FormaPago.precioReferencia` (Boolean), columna `precio_referencia`.
- DTO: `FormaPagoDTO.precioReferencia` (Boolean), posición **antes** de `creadoAt`.
- Frontend interface: `FormaPago.precioReferencia: boolean`.
- Util: `precioPorForma(conIva, porcIva, forma)` en `showroom-frontend/src/app/showroom/precio-referencia.util.ts`.
- Componentes: `formasReferencia` (computed/signal), `formaReferenciaPrimaria`, `precioReferenciaPorForma(r, forma)`, `precioReferenciaPrimario(r)`.

---

## Task 1: Backend — campo `precioReferencia`, recargo negativo y endpoint público

**Files:**
- Modify: `showroom-backend/src/main/java/ar/com/leo/showroom/config/entity/FormaPago.java`
- Modify: `showroom-backend/src/main/java/ar/com/leo/showroom/showroom/dto/FormaPagoDTO.java`
- Modify: `showroom-backend/src/main/java/ar/com/leo/showroom/config/service/FormaPagoService.java`
- Modify: `showroom-backend/src/main/java/ar/com/leo/showroom/auth/config/SecurityConfig.java`

- [ ] **Step 1: Agregar la columna en la entidad**

En `FormaPago.java`, después del campo `orden` (antes de `creadoAt`), agregar:

```java
    /** Si {@code true}, la forma se muestra como "precio de referencia" en el
     *  panel de scan, el visor y el carrito (precio unitario por ítem). El
     *  orden ({@link #orden}) define cuál es la primera/destacada. Default
     *  {@code false}: las formas existentes no se muestran como referencia hasta
     *  que el operador las marque. Filas viejas con NULL se tratan como false en
     *  lectura. */
    @Column(name = "precio_referencia", nullable = false)
    private Boolean precioReferencia;
```

- [ ] **Step 2: Permitir recargo negativo en el DTO + agregar el campo**

En `FormaPagoDTO.java`:

1. Cambiar la anotación de `recargoPorcentaje` para permitir negativos. Reemplazar:

```java
        @NotNull(message = "El recargo es requerido (usar 0 si no hay)")
        @DecimalMin(value = "0.00", message = "El recargo no puede ser negativo")
        @Digits(integer = 4, fraction = 2, message = "Recargo con máximo 4 dígitos enteros y 2 decimales")
        BigDecimal recargoPorcentaje,
```

por:

```java
        @NotNull(message = "El recargo es requerido (usar 0 si no hay)")
        @DecimalMin(value = "-99.99", message = "El recargo no puede ser menor a -99,99% (descuento)")
        @Digits(integer = 4, fraction = 2, message = "Recargo con máximo 4 dígitos enteros y 2 decimales")
        BigDecimal recargoPorcentaje,
```

2. Agregar el campo `precioReferencia` después de `orden` (antes de `creadoAt`):

```java
        Integer orden,

        /** Si la forma se muestra como precio de referencia en scan/visor/carrito.
         *  Default false si viene null. */
        Boolean precioReferencia,

        String creadoAt
```

- [ ] **Step 3: Manejar el campo en el service (crear / actualizar / toDTO) y validar límite inferior del recargo**

En `FormaPagoService.java`:

1. En `crear(...)`, agregar al builder (después de `.orden(...)`):

```java
                .precioReferencia(dto.precioReferencia() != null && dto.precioReferencia())
```

2. En `actualizar(...)`, después de `if (dto.orden() != null) entity.setOrden(dto.orden());`:

```java
        if (dto.precioReferencia() != null) entity.setPrecioReferencia(dto.precioReferencia());
```

3. En `validar(...)`, agregar el límite inferior (ahora que se aceptan negativos). Después del check de `> 1000%`:

```java
        if (dto.recargoPorcentaje() != null
                && dto.recargoPorcentaje().compareTo(new BigDecimal("-99.99")) < 0) {
            // Descuento mayor a 99,99% dejaría el precio en ~0 o negativo.
            throw new IllegalArgumentException("Descuento mayor a 99,99% — revisá el valor.");
        }
```

4. En `toDTO(...)`, agregar el argumento `precioReferencia` en la posición correcta (antes de `creadoAt`):

```java
    public static FormaPagoDTO toDTO(FormaPago f) {
        return new FormaPagoDTO(
                f.getId(),
                f.getNombre(),
                f.getRecargoPorcentaje(),
                f.getCantidadCuotas(),
                f.getAplicaIva(),
                f.getActivo(),
                f.getOrden(),
                f.getPrecioReferencia() != null && f.getPrecioReferencia(),
                f.getCreadoAt() != null ? f.getCreadoAt().toString() : null);
    }
```

- [ ] **Step 4: Exponer `/formas-pago/activas` como público (el visor no está autenticado)**

En `SecurityConfig.java`, junto a las otras reglas `permitAll` de showroom (después de la línea de `config/escalas-descuento`), agregar:

```java
                        .requestMatchers(HttpMethod.GET, "/api/showroom/formas-pago/activas").permitAll()
```

- [ ] **Step 5: Compilar el backend**

Run: `cd showroom-backend && ./mvnw -q compile` (o `mvnw.cmd` en Windows / `./gradlew compileJava` si el proyecto usa Gradle — usar el wrapper presente en `showroom-backend/`).
Expected: BUILD SUCCESS, sin errores de compilación.

- [ ] **Step 6: Arrancar el backend y verificar el campo + acceso público**

Arrancar el backend. Luego:

```bash
# El campo aparece en la lista (autenticado en config):
curl -s http://localhost:8080/api/showroom/config/formas-pago -H "Authorization: Bearer <token>" | grep precioReferencia
# El endpoint activas responde SIN auth (200, no 401):
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8080/api/showroom/formas-pago/activas
```

Expected: el JSON incluye `"precioReferencia": false` en cada forma; el segundo curl imprime `200`.

- [ ] **Step 7: Commit**

```bash
git add showroom-backend/src/main/java/ar/com/leo/showroom/config/entity/FormaPago.java \
        showroom-backend/src/main/java/ar/com/leo/showroom/showroom/dto/FormaPagoDTO.java \
        showroom-backend/src/main/java/ar/com/leo/showroom/config/service/FormaPagoService.java \
        showroom-backend/src/main/java/ar/com/leo/showroom/auth/config/SecurityConfig.java
git commit -m "feat(backend): flag precioReferencia y recargo negativo en formas de pago"
```

---

## Task 2: Frontend — función pura de cálculo `precioPorForma` (TDD)

**Files:**
- Create: `showroom-frontend/src/app/showroom/precio-referencia.util.ts`
- Test: `showroom-frontend/src/app/showroom/precio-referencia.util.spec.ts`

- [ ] **Step 1: Escribir el test que falla**

Crear `precio-referencia.util.spec.ts`:

```typescript
import { precioPorForma } from './precio-referencia.util';

describe('precioPorForma', () => {
  // conIva = 1000, IVA 21%. baseSinIva ≈ 826,45.
  const conIva = 1000;
  const iva = 21;

  it('Transferencia (recargo 0, con IVA) devuelve el precio lista', () => {
    const r = precioPorForma(conIva, iva, { recargoPorcentaje: 0, aplicaIva: true });
    expect(r).toBeCloseTo(1000, 2);
  });

  it('Efectivo (recargo -13, con IVA) descuenta 13% sobre conIva', () => {
    const r = precioPorForma(conIva, iva, { recargoPorcentaje: -13, aplicaIva: true });
    expect(r).toBeCloseTo(870, 2);
  });

  it('Transferencia S/F (recargo -9, con IVA) descuenta 9% sobre conIva', () => {
    const r = precioPorForma(conIva, iva, { recargoPorcentaje: -9, aplicaIva: true });
    expect(r).toBeCloseTo(910, 2);
  });

  it('recargo positivo (financiación) encarece dividiendo por (1 - r/100)', () => {
    // base/(1-0,28) sobre el neto, luego +IVA. Igual a conIva/0,72.
    const r = precioPorForma(conIva, iva, { recargoPorcentaje: 28, aplicaIva: true });
    expect(r).toBeCloseTo(1000 / 0.72, 2);
  });

  it('aplicaIva=false devuelve el precio sin IVA', () => {
    const r = precioPorForma(conIva, iva, { recargoPorcentaje: 0, aplicaIva: false });
    expect(r).toBeCloseTo(1000 / 1.21, 2);
  });

  it('conIva null devuelve 0', () => {
    expect(precioPorForma(null, iva, { recargoPorcentaje: -13, aplicaIva: true })).toBe(0);
  });

  it('porcIva null/0 trata el precio como sin IVA gravable', () => {
    const r = precioPorForma(1000, 0, { recargoPorcentaje: -10, aplicaIva: true });
    expect(r).toBeCloseTo(900, 2);
  });

  it('recargo null se trata como 0', () => {
    const r = precioPorForma(conIva, iva, { recargoPorcentaje: null, aplicaIva: true });
    expect(r).toBeCloseTo(1000, 2);
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `cd showroom-frontend && npx ng test --watch=false --browsers=ChromeHeadless --include='**/precio-referencia.util.spec.ts'`
Expected: FAIL — `Cannot find module './precio-referencia.util'` o "precioPorForma is not a function".

(Si ChromeHeadless no está disponible en el entorno, usar el browser configurado por default del proyecto; lo importante es que el spec corra.)

- [ ] **Step 3: Implementar la función**

Crear `precio-referencia.util.ts`:

```typescript
/**
 * Datos mínimos de una forma de pago necesarios para calcular su precio de
 * display. Subconjunto de {@link FormaPago} — se acepta este shape acotado para
 * poder testear la función sin construir una forma completa.
 */
export interface FormaPagoCalc {
  recargoPorcentaje: number | null;
  aplicaIva: boolean | null;
}

/**
 * Precio unitario que paga el cliente con una forma de pago dada, calculado
 * sobre el PVP gastro CON IVA del producto.
 *
 * Fórmula (coincide con el cálculo del carrito):
 *   baseSinIva = conIva / (1 + iva/100)
 *   recargo > 0 → baseSinIva / (1 - r/100)        (encarece: financiación)
 *   recargo = 0 → baseSinIva
 *   recargo < 0 → baseSinIva * (1 - |r|/100)       (descuenta: contado)
 *   resultado   = aplicaIva ? ajustado * (1 + iva/100) : ajustado
 *
 * El backend del pedido ignora los recargos ≤ 0, así que un descuento acá solo
 * afecta el precio MOSTRADO, no lo que se factura en DUX (decisión del negocio).
 */
export function precioPorForma(
  conIva: number | null,
  porcIva: number | null,
  forma: FormaPagoCalc,
): number {
  if (conIva == null) return 0;
  const iva = porcIva ?? 0;
  const baseSinIva = iva > 0 ? conIva / (1 + iva / 100) : conIva;
  const r = forma.recargoPorcentaje ?? 0;
  let ajustadoSinIva: number;
  if (r > 0) {
    ajustadoSinIva = baseSinIva / (1 - r / 100);
  } else if (r < 0) {
    ajustadoSinIva = baseSinIva * (1 - Math.abs(r) / 100);
  } else {
    ajustadoSinIva = baseSinIva;
  }
  const aplicaIva = forma.aplicaIva ?? true;
  return aplicaIva && iva > 0 ? ajustadoSinIva * (1 + iva / 100) : ajustadoSinIva;
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `cd showroom-frontend && npx ng test --watch=false --browsers=ChromeHeadless --include='**/precio-referencia.util.spec.ts'`
Expected: PASS — 8 specs OK.

- [ ] **Step 5: Commit**

```bash
git add showroom-frontend/src/app/showroom/precio-referencia.util.ts \
        showroom-frontend/src/app/showroom/precio-referencia.util.spec.ts
git commit -m "feat(frontend): util precioPorForma con descuentos por recargo negativo"
```

---

## Task 3: Frontend — modelo + configuración (check "precio de referencia", recargo negativo)

**Files:**
- Modify: `showroom-frontend/src/app/showroom/models.ts` (interface `FormaPago`, ~línea 490)
- Modify: `showroom-frontend/src/app/showroom/configuracion-page/configuracion-page.ts`
- Modify: `showroom-frontend/src/app/showroom/configuracion-page/configuracion-page.html`

- [ ] **Step 1: Agregar el campo a la interface `FormaPago`**

En `models.ts`, dentro de `export interface FormaPago`, después de `orden: number;`:

```typescript
  /** Si la forma se muestra como precio de referencia en scan/visor/carrito.
   *  El `orden` define cuál es la primera/destacada. Default false. */
  precioReferencia: boolean;
```

- [ ] **Step 2: Agregar el signal del form y manejarlo en abrir/guardar**

En `configuracion-page.ts`:

1. Junto a los signals del form de forma de pago (después de `formActivoPago`):

```typescript
  readonly formPrecioReferencia = signal(false);
```

2. En `abrirDialogCrearForma()`, después de `this.formActivoPago.set(true);`:

```typescript
    this.formPrecioReferencia.set(false);
```

3. En `abrirDialogEditarForma(f)`, después de `this.formActivoPago.set(f.activo);`:

```typescript
    this.formPrecioReferencia.set(f.precioReferencia ?? false);
```

4. En `guardarForma()`, **eliminar** el bloque que rechaza el recargo negativo:

```typescript
    if (recargo < 0) {
      this.toast.add({
        severity: 'warn',
        summary: 'Recargo inválido',
        detail: 'El recargo no puede ser negativo (usar 0 si no hay).',
      });
      // ... (return)
    }
```

(Borrar ese `if` completo — ahora los negativos son válidos como descuento.)

5. En `guardarForma()`, agregar al `payload`:

```typescript
      precioReferencia: this.formPrecioReferencia(),
```

- [ ] **Step 3: Agregar el check en el dialog y permitir negativo en el inputNumber**

En `configuracion-page.html`:

1. En el `p-inputnumber` del recargo (`inputId="formRecargo"`), cambiar `[min]="0"` por `[min]="-99.99"`.

2. Después del bloque del check `formActivoPago` (el `<label>` que termina la lista de checks del dialog, ~línea 1083), agregar:

```html
    <label class="flex items-start gap-2 cursor-pointer p-2 rounded-lg border border-surface-200 dark:border-surface-700">
      <p-checkbox [ngModel]="formPrecioReferencia()" (ngModelChange)="formPrecioReferencia.set($event)" [binary]="true" inputId="formPrecioReferencia"
        [disabled]="guardandoForma()" />
      <div class="flex flex-col gap-0.5 flex-1">
        <span class="text-sm font-medium">Mostrar como precio de referencia</span>
        <span class="text-xs text-muted-color">
          Se muestra en el panel de scan, el visor y el carrito. Usá un <strong>recargo negativo</strong> (ej. −13) para un descuento sobre el precio lista. El <strong>orden</strong> define cuál aparece primero (la primera es la destacada y la que usa el carrito).
        </span>
      </div>
    </label>
```

3. (Opcional, recomendado) Actualizar el texto de ayuda del recargo (~línea 1029-1033) para mencionar que ahora admite negativos como descuento directo:

```html
      <span class="text-xs text-muted-color leading-relaxed">
        Positivo = <strong>recargo de financiación</strong> (<code class="font-mono">precio = efectivo / (1 − %/100)</code>). Negativo = <strong>descuento</strong> directo sobre el precio lista (<code class="font-mono">precio = lista × (1 − |%|/100)</code>), usado para los precios de referencia (Efectivo, Transferencia S/F).
      </span>
```

- [ ] **Step 4: Build del frontend**

Run: `cd showroom-frontend && npx ng build`
Expected: build OK, sin errores de tipos (el payload `Partial<FormaPago>` acepta `precioReferencia`).

- [ ] **Step 5: Verificación manual**

Arrancar la app, ir a `/configuracion`, crear/editar una forma de pago:
- El check "Mostrar como precio de referencia" aparece y persiste.
- Se puede guardar un recargo negativo (ej. −13) sin error.

- [ ] **Step 6: Commit**

```bash
git add showroom-frontend/src/app/showroom/models.ts \
        showroom-frontend/src/app/showroom/configuracion-page/configuracion-page.ts \
        showroom-frontend/src/app/showroom/configuracion-page/configuracion-page.html
git commit -m "feat(config): check precio de referencia y recargo negativo en formas de pago"
```

---

## Task 4: Showroom-page — lógica TS de precios de referencia

**Files:**
- Modify: `showroom-frontend/src/app/showroom/showroom-page/showroom-page.ts`

- [ ] **Step 1: Importar el util**

Agregar al import existente desde `'../precio-referencia.util'` (crear la línea de import):

```typescript
import { precioPorForma } from '../precio-referencia.util';
```

- [ ] **Step 2: Computeds de formas de referencia**

Después del signal `formaPagoSeleccionada` (~línea 348), agregar:

```typescript
  /** Formas de pago marcadas para mostrarse como precio de referencia, ordenadas
   *  por `orden` asc. La primera es la destacada y la que usa el carrito por ítem. */
  readonly formasReferencia = computed(() =>
    this.formasPagoActivas()
      .filter((f) => f.precioReferencia)
      .sort((a, b) => (a.orden ?? 0) - (b.orden ?? 0)),
  );

  /** Primera forma de referencia (menor `orden`), o null si no hay ninguna marcada. */
  readonly formaReferenciaPrimaria = computed(() => this.formasReferencia()[0] ?? null);
```

- [ ] **Step 3: Métodos de cálculo de precio de referencia**

Agregar como métodos del componente (cerca de `precioConDescuento`, ~línea 619):

```typescript
  /** Precio de referencia de un producto (scan o ítem de carrito) para una
   *  forma de pago dada. Calculado sobre el PVP gastro con IVA. */
  precioReferenciaPorForma(
    r: { pvpKtGastroConIva: number | null; porcIva: number | null },
    forma: FormaPago,
  ): number {
    return precioPorForma(r.pvpKtGastroConIva, r.porcIva, forma);
  }

  /** Precio de la forma de referencia primaria. Si no hay formas marcadas, cae al
   *  PVP gastro sin IVA (comportamiento previo) para no romper el display. */
  precioReferenciaPrimario(
    r: { pvpKtGastroConIva: number | null; porcIva: number | null; pvpKtGastroSinIva: number | null },
  ): number {
    const f = this.formaReferenciaPrimaria();
    return f ? precioPorForma(r.pvpKtGastroConIva, r.porcIva, f) : (r.pvpKtGastroSinIva ?? 0);
  }
```

- [ ] **Step 4: Cambiar el subtotal de línea del carrito a la forma primaria**

Reemplazar el método `subtotal(it)` (~línea 568):

```typescript
  /** Subtotal de la línea SIN descuento, al precio de referencia primario
   *  (mismo precio que se muestra como c/u). El descuento por escala se muestra
   *  solo a nivel total. */
  subtotal(it: CarritoItem): number {
    return this.precioReferenciaPrimario(it) * it.cantidad;
  }
```

Nota: verificar con `grep -n "subtotal(" showroom-page.html` que `subtotal(it)` solo se use en la grilla (display). Los totales globales usan `subtotalPreDescuento` / `totalCarrito` (sin cambios).

- [ ] **Step 5: Build del frontend**

Run: `cd showroom-frontend && npx ng build`
Expected: build OK.

- [ ] **Step 6: Commit**

```bash
git add showroom-frontend/src/app/showroom/showroom-page/showroom-page.ts
git commit -m "feat(showroom): computeds y cálculo de precios de referencia"
```

---

## Task 5: Showroom-page — display HTML (bloque principal, tiles, carrito)

**Files:**
- Modify: `showroom-frontend/src/app/showroom/showroom-page/showroom-page.html`

- [ ] **Step 1: Reemplazar el bloque "PRECIO PRINCIPAL"**

Reemplazar el bloque actual (~líneas 331-343, desde `@if (r.pvpKtGastroSinIva != null && r.pvpKtGastroSinIva > 0) {` y su `<div ...>Precio... pvpKtGastroSinIva ...</div>`) por:

```html
          <!-- PRECIOS DE REFERENCIA — una línea por forma marcada; la primera
               destacada grande. Fallback al precio lista si no hay formas. -->
          @if (r.pvpKtGastroConIva != null && r.pvpKtGastroConIva > 0) {
          <div class="relative rounded-xl border-2 border-[#FF861C]/50 dark:border-primary-900 bg-surface-0 dark:bg-surface-900 p-5 sm:p-6 shadow-sm flex flex-col gap-3">
            @if (formasReferencia().length > 0) {
              @for (forma of formasReferencia(); track forma.id; let first = $first) {
                @if (first) {
                  <div>
                    <div class="text-xs font-semibold uppercase tracking-wider text-[#3B1E09]/70 dark:text-muted-color mb-1">
                      {{ forma.nombre }}
                    </div>
                    <div class="flex items-baseline gap-2 flex-wrap">
                      <span class="text-2xl sm:text-3xl font-bold text-[#FF861C] leading-none">$</span>
                      <span class="text-4xl sm:text-5xl font-bold tabular-nums text-[#3B1E09] dark:text-surface-0 leading-none">
                        {{ precioReferenciaPorForma(r, forma) | number:'1.0-0' }}
                      </span>
                    </div>
                  </div>
                } @else {
                  <div class="flex items-baseline justify-between gap-2 border-t border-surface-200 dark:border-surface-700 pt-2">
                    <span class="text-xs font-semibold uppercase tracking-wider text-[#3B1E09]/60 dark:text-muted-color">{{ forma.nombre }}</span>
                    <span class="text-lg sm:text-xl font-bold tabular-nums text-[#3B1E09] dark:text-surface-0">{{ precioReferenciaPorForma(r, forma) | currency:'ARS':'symbol':'1.0-0' }}</span>
                  </div>
                }
              }
            } @else {
              <div>
                <div class="text-xs font-semibold uppercase tracking-wider text-[#3B1E09]/70 dark:text-muted-color mb-1">Precio</div>
                <div class="flex items-baseline gap-2 flex-wrap">
                  <span class="text-2xl sm:text-3xl font-bold text-[#FF861C] leading-none">$</span>
                  <span class="text-4xl sm:text-5xl font-bold tabular-nums text-[#3B1E09] dark:text-surface-0 leading-none">{{ r.pvpKtGastroConIva | number:'1.0-0' }}</span>
                </div>
              </div>
            }
          </div>
```

**Importante:** este `@if (r.pvpKtGastroConIva...)` ahora abre el bloque que contiene también el aviso de rubro excluido y los tiles de escala (que hoy viven dentro del `@if` de `pvpKtGastroSinIva`). Mantener la estructura de cierre: el `}` que cerraba el `@if (pvpKtGastroSinIva...)` ahora cierra este `@if (pvpKtGastroConIva...)` (es el mismo lugar, ~línea 413).

- [ ] **Step 2: Cambiar las referencias de umbral de escala a la forma primaria**

En el bloque de tiles "Comprá más y ahorrás" (~líneas 377-409), reemplazar los 3 usos de `r.pvpKtGastroSinIva` que evalúan el umbral:

- `[class.opacity-50]="haySuperior(r.pvpKtGastroSinIva, escala)"` → `[class.opacity-50]="haySuperior(precioReferenciaPrimario(r), escala)"`
- `@if (haySuperior(r.pvpKtGastroSinIva, escala)) {` → `@if (haySuperior(precioReferenciaPrimario(r), escala)) {`
- `} @else if (r.pvpKtGastroSinIva >= escala.umbralMin) {` → `} @else if (precioReferenciaPrimario(r) >= escala.umbralMin) {`

- [ ] **Step 3: Reemplazar el monto único del tile por una línea por forma**

Dentro de cada tile, reemplazar el bloque del precio único + "Ahorrás" (~líneas 401-407):

```html
                  <div class="text-2xl sm:text-3xl font-bold tabular-nums leading-none mt-0.5" [class]="c.textBig">
                    {{ precioConDescuento(r.pvpKtGastroSinIva, escala.porcentaje) | currency:'ARS':'symbol':'1.0-0' }}
                  </div>
                  <div class="text-xs inline-flex items-center gap-1" [class]="c.textSmall">
                    <i class="pi pi-arrow-down text-[0.65rem]"></i>
                    Ahorrás {{ ahorro(r.pvpKtGastroSinIva, escala.porcentaje) | currency:'ARS':'symbol':'1.0-0' }} c/u
                  </div>
```

por (una línea por forma de referencia; fallback al precio lista si no hay formas):

```html
                  @if (formasReferencia().length > 0) {
                    <div class="flex flex-col gap-1 mt-0.5">
                      @for (forma of formasReferencia(); track forma.id) {
                        <div class="flex items-baseline justify-between gap-2">
                          <span class="text-[0.7rem] font-medium" [class]="c.textSmall">{{ forma.nombre }}</span>
                          <span class="text-base sm:text-lg font-bold tabular-nums" [class]="c.textBig">
                            {{ precioConDescuento(precioReferenciaPorForma(r, forma), escala.porcentaje) | currency:'ARS':'symbol':'1.0-0' }}
                          </span>
                        </div>
                      }
                    </div>
                  } @else {
                    <div class="text-2xl sm:text-3xl font-bold tabular-nums leading-none mt-0.5" [class]="c.textBig">
                      {{ precioConDescuento(r.pvpKtGastroConIva, escala.porcentaje) | currency:'ARS':'symbol':'1.0-0' }}
                    </div>
                  }
```

- [ ] **Step 4: Carrito — precio unitario c/u a la forma primaria**

En la grilla del carrito (~línea 758), reemplazar:

```html
                {{ it.pvpKtGastroSinIva | currency:'ARS':'symbol':'1.0-0' }} c/u
```

por:

```html
                {{ precioReferenciaPrimario(it) | currency:'ARS':'symbol':'1.0-0' }} c/u
```

(El subtotal de línea, línea 755, usa `subtotal(it)` que ya quedó alineado en Task 4.)

- [ ] **Step 5: Build del frontend**

Run: `cd showroom-frontend && npx ng build`
Expected: build OK, sin errores de template.

- [ ] **Step 6: Verificación manual**

Con formas Efectivo(−13)/Transferencia(0)/Transf. S/F(−9) marcadas como referencia:
- Escanear un producto: el bloque muestra Efectivo destacado + Transferencia + Transf. S/F.
- Cada tile de volumen muestra las 3 líneas con el descuento de escala aplicado.
- En el carrito, el c/u y el subtotal de línea usan el precio Efectivo.

- [ ] **Step 7: Commit**

```bash
git add showroom-frontend/src/app/showroom/showroom-page/showroom-page.html
git commit -m "feat(showroom): display de precios de referencia en scan y carrito"
```

---

## Task 6: Visor-page — carga de formas + display HTML

**Files:**
- Modify: `showroom-frontend/src/app/showroom/visor-page/visor-page.ts`
- Modify: `showroom-frontend/src/app/showroom/visor-page/visor-page.html`

- [ ] **Step 1: Imports y signal de formas de referencia**

En `visor-page.ts`:

1. Agregar a los imports de `../models`: `FormaPago`. Y agregar el import del util:

```typescript
import { EscalaDescuento, FormaPago, ScanResult, SesionShowroom, rubroExcluyeDescuentos } from '../models';
import { precioPorForma } from '../precio-referencia.util';
```

2. Junto al signal `escalas` (~línea 83), agregar:

```typescript
  /** Formas de pago marcadas como precio de referencia, ordenadas por `orden`.
   *  Se cargan al iniciar vía el endpoint público de formas activas. */
  readonly formasReferencia = signal<FormaPago[]>([]);

  /** Primera forma de referencia (destacada). */
  readonly formaReferenciaPrimaria = computed(() => this.formasReferencia()[0] ?? null);
```

- [ ] **Step 2: Cargar las formas en el constructor**

En el constructor, junto a `this.api.obtenerEscalasDescuento().subscribe(...)` (~línea 148), agregar:

```typescript
    this.api.listarFormasPagoActivas().subscribe({
      next: (lista) =>
        this.formasReferencia.set(
          lista
            .filter((f) => f.precioReferencia)
            .sort((a, b) => (a.orden ?? 0) - (b.orden ?? 0)),
        ),
      error: () => {
        /* sin formas, el visor cae al precio lista en el display */
      },
    });
```

- [ ] **Step 3: Métodos de cálculo (espejo del showroom-page)**

Agregar como métodos del componente (cerca de `precioConDescuento`, ~línea 349):

```typescript
  /** Precio de referencia de un producto para una forma de pago dada. */
  precioReferenciaPorForma(
    r: { pvpKtGastroConIva: number | null; porcIva: number | null },
    forma: FormaPago,
  ): number {
    return precioPorForma(r.pvpKtGastroConIva, r.porcIva, forma);
  }

  /** Precio de la forma primaria; cae al PVP sin IVA si no hay formas marcadas. */
  precioReferenciaPrimario(
    r: { pvpKtGastroConIva: number | null; porcIva: number | null; pvpKtGastroSinIva: number | null },
  ): number {
    const f = this.formaReferenciaPrimaria();
    return f ? precioPorForma(r.pvpKtGastroConIva, r.porcIva, f) : (r.pvpKtGastroSinIva ?? 0);
  }
```

- [ ] **Step 4: Reemplazar el bloque "Precio principal" del visor**

En `visor-page.html`, reemplazar el bloque (~líneas 156-167, `@if (r.pvpKtGastroSinIva...)` con el div "Precio") por:

```html
<!-- Precios de referencia -->
@if (r.pvpKtGastroConIva != null && r.pvpKtGastroConIva > 0) {
<div class="relative rounded-2xl border-2 border-[#FF861C]/50 dark:border-primary-900 bg-surface-0 dark:bg-surface-900 p-5 sm:p-6 shadow-sm flex flex-col gap-3">
  @if (formasReferencia().length > 0) {
    @for (forma of formasReferencia(); track forma.id; let first = $first) {
      @if (first) {
        <div class="text-center">
          <div class="text-xs font-semibold uppercase tracking-wider text-[#3B1E09]/70 dark:text-muted-color mb-1">{{ forma.nombre }}</div>
          <div class="flex items-baseline gap-2 flex-wrap justify-center">
            <span class="text-3xl sm:text-4xl font-bold text-[#FF861C] leading-none">$</span>
            <span class="text-5xl sm:text-6xl font-bold tabular-nums text-[#3B1E09] dark:text-surface-0 leading-none">{{ precioReferenciaPorForma(r, forma) | number:'1.0-0' }}</span>
          </div>
        </div>
      } @else {
        <div class="flex items-baseline justify-between gap-2 border-t border-surface-200 dark:border-surface-700 pt-2">
          <span class="text-sm font-semibold uppercase tracking-wider text-[#3B1E09]/60 dark:text-muted-color">{{ forma.nombre }}</span>
          <span class="text-xl sm:text-2xl font-bold tabular-nums text-[#3B1E09] dark:text-surface-0">{{ precioReferenciaPorForma(r, forma) | currency:'ARS':'symbol':'1.0-0' }}</span>
        </div>
      }
    }
  } @else {
    <div class="text-center">
      <div class="text-xs font-semibold uppercase tracking-wider text-[#3B1E09]/70 dark:text-muted-color mb-1">Precio</div>
      <div class="flex items-baseline gap-2 flex-wrap justify-center">
        <span class="text-3xl sm:text-4xl font-bold text-[#FF861C] leading-none">$</span>
        <span class="text-5xl sm:text-6xl font-bold tabular-nums text-[#3B1E09] dark:text-surface-0 leading-none">{{ r.pvpKtGastroConIva | number:'1.0-0' }}</span>
      </div>
    </div>
  }
</div>
```

**Importante:** igual que en showroom, este `@if (r.pvpKtGastroConIva...)` envuelve también el aviso de rubro excluido y los tiles. El `}` de cierre (~línea 231) ahora cierra este `@if`.

- [ ] **Step 5: Umbral de escala + líneas por forma en los tiles del visor**

En el bloque de tiles (~líneas 199-225):

1. Reemplazar los 3 usos de umbral:
- `[class.opacity-50]="haySuperior(r.pvpKtGastroSinIva, escala)"` → `[class.opacity-50]="haySuperior(precioReferenciaPrimario(r), escala)"`
- `@if (haySuperior(r.pvpKtGastroSinIva, escala)) {` → `@if (haySuperior(precioReferenciaPrimario(r), escala)) {`
- `} @else if (r.pvpKtGastroSinIva >= escala.umbralMin) {` → `} @else if (precioReferenciaPrimario(r) >= escala.umbralMin) {`

2. Reemplazar el monto único + "Ahorrás" (~líneas 219-225) por:

```html
      @if (formasReferencia().length > 0) {
        <div class="flex flex-col gap-1 mt-0.5">
          @for (forma of formasReferencia(); track forma.id) {
            <div class="flex items-baseline justify-between gap-2">
              <span class="text-[0.7rem] font-medium" [class]="c.textSmall">{{ forma.nombre }}</span>
              <span class="text-base sm:text-lg font-bold tabular-nums" [class]="c.textBig">
                {{ precioConDescuento(precioReferenciaPorForma(r, forma), escala.porcentaje) | currency:'ARS':'symbol':'1.0-0' }}
              </span>
            </div>
          }
        </div>
      } @else {
        <div class="text-2xl sm:text-3xl font-bold tabular-nums leading-none mt-0.5" [class]="c.textBig">
          {{ precioConDescuento(r.pvpKtGastroConIva, escala.porcentaje) | currency:'ARS':'symbol':'1.0-0' }}
        </div>
      }
```

- [ ] **Step 6: Build del frontend**

Run: `cd showroom-frontend && npx ng build`
Expected: build OK.

- [ ] **Step 7: Verificación manual**

Abrir `/visor/<username>`, escanear desde el puesto:
- El visor muestra los 3 precios de referencia (primera destacada).
- Los tiles de volumen muestran las 3 líneas con descuento de escala.
- Funciona sin autenticación (el endpoint `/formas-pago/activas` es público).

- [ ] **Step 8: Commit**

```bash
git add showroom-frontend/src/app/showroom/visor-page/visor-page.ts \
        showroom-frontend/src/app/showroom/visor-page/visor-page.html
git commit -m "feat(visor): display de precios de referencia"
```

---

## Task 7: Verificación integral end-to-end

**Files:** ninguno (solo verificación manual).

- [ ] **Step 1: Configurar las formas de referencia**

En `/configuracion`, crear/ajustar:
- "Efectivo" — recargo `−13`, aplicaIva ✓, orden `0`, precio de referencia ✓.
- "Transferencia" — recargo `0`, aplicaIva ✓, orden `1`, precio de referencia ✓.
- "Transferencia S/F" — recargo `−9`, aplicaIva ✓, orden `2`, precio de referencia ✓.

- [ ] **Step 2: Verificar coherencia de números**

Escanear un producto con `pvpKtGastroConIva` conocido (ej. lista = $17.974):
- Efectivo ≈ `17.974 × 0,87 = 15.637`.
- Transferencia ≈ `17.974`.
- Transferencia S/F ≈ `17.974 × 0,91 = 16.356`.

Verificar que el panel de scan, el visor y el c/u del carrito (Efectivo) coincidan.

- [ ] **Step 3: Verificar que el pedido a DUX NO cambió**

Armar un carrito, elegir cualquier forma, crear pedido. Confirmar (en el detalle del pedido / logs) que el precio unitario que sube a DUX sigue siendo `pvpKtGastroConIva` (precio lista), sin el descuento de la forma de referencia.

- [ ] **Step 4: Casos borde**

- Producto MAQUINAS INDUSTRIALES: muestra los precios de referencia base, sin tiles de volumen (aviso "sin descuentos por monto").
- Sin ninguna forma marcada como referencia: scan/visor/carrito caen al precio lista (`pvpKtGastroConIva`) sin romperse.

---

## Self-Review (completado por el autor del plan)

**Spec coverage:**
- Flag `precioReferencia` → Task 1, 3.
- Recargo negativo como descuento → Task 1 (DTO/service), Task 2 (cálculo), Task 3 (config).
- Cálculo de display (fórmula) → Task 2 (TDD).
- Scan: bloque principal + tiles → Task 4, 5.
- Visor: bloque + tiles → Task 6.
- Carrito: c/u + subtotal de línea a forma primaria → Task 4, 5.
- Umbral de escala vs forma primaria → Task 5, 6.
- Configuración (check) → Task 3.
- Endpoint público para visor → Task 1.
- Pedido a DUX sin cambios → verificado en Task 7.

**Placeholders:** ninguno — todo el código está explícito.

**Type consistency:** `precioReferencia` (bool) consistente backend/DTO/frontend; `precioPorForma`, `precioReferenciaPorForma`, `precioReferenciaPrimario`, `formasReferencia`, `formaReferenciaPrimaria` usados con la misma firma en showroom-page y visor-page.

**Fuera de alcance (confirmado con el usuario):** presupuestos / cotizaciones / PDFs; tratamiento del IVA por cuotas; precio que sube a DUX.
