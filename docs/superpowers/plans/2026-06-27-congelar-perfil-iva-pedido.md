# Congelar el perfil de IVA al convertir presupuesto en pedido — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** En pedidos de presupuesto, congelar el perfil (menaje/maquinaria) con que se cotizó cada ítem usando el flag `precioReferenciaConIva`, en vez de re-derivarlo por rubro.

**Architecture:** El flag `precioReferenciaConIva` (ya persistido en el presupuesto) viaja en `CrearPedidoRequestDTO.Item`. En `PedidoService`, un helper `resolverEsMaq` decide el perfil: congelado (`esMaq = !precioReferenciaConIva`) en pedidos de presupuesto con flag, o por rubro como fallback. Se aplica en los DOS loops que calculan `esMaq` (persistencia del pedido y payload a DUX) para que no diverjan.

**Tech Stack:** Spring Boot 4 + Java 25 (record DTO, JUnit puro), Angular 21 (signals). Tests: `mvn -f showroom-backend/pom.xml test`, `cd showroom-frontend && npm run build`.

## Global Constraints

- Congelar solo cuando `origenPresupuesto == true` **y** `precioReferenciaConIva != null`. Showroom normal o flag null → derivar por rubro (comportamiento actual).
- Semántica: `esMaq = !precioReferenciaConIva` (`true`=menaje/con IVA, `false`=maquinaria/sin IVA).
- Aplicar el helper en AMBOS call-sites de `esMaq` en `PedidoService` (persistencia ~564 y payload DUX ~894) para que el ítem persistido y lo facturado coincidan.
- No tocar el flujo del showroom normal, ni el precio base, ni descuentos/recargos más allá del perfil. No retro-rellenar presupuestos viejos.

---

### Task 1: Backend — flag en el request + helper `resolverEsMaq` + ambos call-sites (TDD)

**Files:**
- Modify: `showroom-backend/src/main/java/ar/com/leo/showroom/showroom/dto/CrearPedidoRequestDTO.java` (record `Item`, tras `comentarios` ~129)
- Modify: `showroom-backend/src/main/java/ar/com/leo/showroom/pedido/service/PedidoService.java` (helper nuevo junto a `normalizarRubro` ~961; reemplazar `esMaq` en ~564 y ~894)
- Modify: `showroom-backend/src/main/java/ar/com/leo/showroom/presupuesto/dto/GenerarPresupuestoRequestDTO.java` (comentario de `precioReferenciaConIva` ~99-105)
- Test: `showroom-backend/src/test/java/ar/com/leo/showroom/pedido/service/ResolverEsMaqTest.java` (crear)

**Interfaces:**
- Produces: `CrearPedidoRequestDTO.Item.precioReferenciaConIva()` → `Boolean` (nullable, último componente). `PedidoService.resolverEsMaq(boolean origenPresupuesto, Boolean precioReferenciaConIva, String rubroItem, Set<String> rubrosMaq)` → `boolean` (static package-private). Consumidos por los call-sites y por Task 2 (el campo TS).

- [ ] **Step 1: Escribir el test de `resolverEsMaq` que falla**

Crear `showroom-backend/src/test/java/ar/com/leo/showroom/pedido/service/ResolverEsMaqTest.java`:

```java
package ar.com.leo.showroom.pedido.service;

import org.junit.jupiter.api.Test;

import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

/** El perfil (maquinaria/menaje) se CONGELA desde `precioReferenciaConIva` en
 *  pedidos de presupuesto, y se deriva por rubro en el resto. */
class ResolverEsMaqTest {

    private static final Set<String> RUBROS_MAQ = Set.of("MAQUINAS INDUSTRIALES");

    @Test
    void presupuesto_conFlagFalse_congelaMaquinaria() {
        // flag=false ⇒ se cotizó sin IVA (maquinaria) ⇒ esMaq=true, aunque el rubro no sea maq.
        assertThat(PedidoService.resolverEsMaq(true, Boolean.FALSE, "BAZAR", RUBROS_MAQ)).isTrue();
    }

    @Test
    void presupuesto_conFlagTrue_congelaMenaje() {
        // flag=true ⇒ se cotizó con IVA (menaje) ⇒ esMaq=false, aunque el rubro sea maquinaria.
        assertThat(PedidoService.resolverEsMaq(true, Boolean.TRUE, "MAQUINAS INDUSTRIALES", RUBROS_MAQ)).isFalse();
    }

    @Test
    void presupuesto_sinFlag_derivaPorRubro() {
        assertThat(PedidoService.resolverEsMaq(true, null, "MAQUINAS INDUSTRIALES", RUBROS_MAQ)).isTrue();
        assertThat(PedidoService.resolverEsMaq(true, null, "BAZAR", RUBROS_MAQ)).isFalse();
    }

    @Test
    void showroomNormal_ignoraFlag_yDerivaPorRubro() {
        // origenPresupuesto=false ⇒ siempre por rubro, aunque venga el flag.
        assertThat(PedidoService.resolverEsMaq(false, Boolean.FALSE, "MAQUINAS INDUSTRIALES", RUBROS_MAQ)).isTrue();
        assertThat(PedidoService.resolverEsMaq(false, Boolean.TRUE, "BAZAR", RUBROS_MAQ)).isFalse();
    }
}
```

- [ ] **Step 2: Correr el test y verificar que falla a compilar**

Run: `mvn -f showroom-backend/pom.xml -q -Dtest=ResolverEsMaqTest test`
Expected: FAIL — "cannot find symbol: method resolverEsMaq(...)".

- [ ] **Step 3: Agregar el componente al record `CrearPedidoRequestDTO.Item`**

En `CrearPedidoRequestDTO.java`, agregar como último componente del record `Item` (tras `comentarios`):

```java
            String comentarios,
            /** Perfil de IVA con que se cotizó el ítem en el presupuesto
             *  (true=menaje/con IVA, false=maquinaria/sin IVA). Solo en pedidos
             *  de presupuesto: el backend CONGELA el perfil con este flag en vez
             *  de re-derivarlo por rubro. Null = derivar por rubro (showroom o
             *  presupuesto viejo). */
            Boolean precioReferenciaConIva
    ) {
    }
```

- [ ] **Step 4: Implementar el helper `resolverEsMaq`**

En `PedidoService.java`, junto a `normalizarRubro` (~961), agregar:

```java
    /** Perfil (maquinaria/menaje) del ítem. En pedidos de presupuesto que traen
     *  el snapshot {@code precioReferenciaConIva}, CONGELA el perfil con que se
     *  cotizó ({@code esMaq = !precioReferenciaConIva}), para no re-derivarlo por
     *  rubro si la lista de rubros sin IVA cambió entre cotizar y convertir. En
     *  el showroom normal, o si el presupuesto es viejo (flag null), deriva por
     *  rubro como hasta ahora. */
    static boolean resolverEsMaq(boolean origenPresupuesto, Boolean precioReferenciaConIva,
                                 String rubroItem, Set<String> rubrosMaq) {
        if (origenPresupuesto && precioReferenciaConIva != null) {
            return !precioReferenciaConIva;
        }
        return !rubrosMaq.isEmpty() && rubrosMaq.contains(normalizarRubro(rubroItem));
    }
```

- [ ] **Step 5: Correr el test y verificar que pasa**

Run: `mvn -f showroom-backend/pom.xml -q -Dtest=ResolverEsMaqTest test`
Expected: PASS (4 tests).

- [ ] **Step 6: Usar `resolverEsMaq` en el loop de `crearPedido` (~564)**

En `PedidoService.java`, reemplazar (la del bloque que persiste el ítem, ~564):

```java
            boolean esMaq = !rubrosMaq.isEmpty() && rubrosMaq.contains(normalizarRubro(rubroItem));
            BigDecimal recargoItem = recargoPerfil(formaPago, esMaq);
```

por:

```java
            boolean esMaq = resolverEsMaq(
                    request.origenPresupuesto(), it.precioReferenciaConIva(), rubroItem, rubrosMaq);
            BigDecimal recargoItem = recargoPerfil(formaPago, esMaq);
```

- [ ] **Step 7: Usar `resolverEsMaq` en el loop del payload DUX (~894)**

En `PedidoService.java`, reemplazar la otra ocurrencia (la del armado del payload a DUX, ~894):

```java
            boolean esMaq = !rubrosMaq.isEmpty() && rubrosMaq.contains(normalizarRubro(rubroItem));
```

por:

```java
            boolean esMaq = resolverEsMaq(
                    request.origenPresupuesto(), it.precioReferenciaConIva(), rubroItem, rubrosMaq);
```

(Si tras el Step 6 quedara una sola ocurrencia del patrón viejo, esa es la del payload DUX — confirmar por el comentario "Precio a DUX = …" justo debajo.)

- [ ] **Step 8: Revertir/actualizar el comentario de `precioReferenciaConIva` en el presupuesto**

En `GenerarPresupuestoRequestDTO.java` (~99-105), reemplazar el comentario que dice que el pedido NO lo consume por:

```java
            /** True si {@link #precioReferencia} es un valor CON IVA (perfil
             *  menaje), false si es SIN IVA (maquinaria) — snapshot del perfil de
             *  IVA con que se cotizó el ítem. Al transformar el presupuesto en
             *  pedido, {@code PedidoService} CONGELA el perfil con este flag
             *  (esMaq = !precioReferenciaConIva) en vez de re-derivarlo por rubro,
             *  para que DUX facture con el mismo perfil cotizado aunque la lista
             *  de rubros sin IVA haya cambiado. Null en presupuestos viejos →
             *  el pedido cae a derivar por rubro. */
            Boolean precioReferenciaConIva
```

- [ ] **Step 9: Compilar + suite completa**

Run: `mvn -f showroom-backend/pom.xml test 2>&1 | grep -E "Tests run: [0-9]+, Failures.*Skipped: [0-9]+$|BUILD"`
Expected: `BUILD SUCCESS`, 0 failures (incluye ResolverEsMaqTest y los call-sites compilando con el nuevo `it.precioReferenciaConIva()`).

- [ ] **Step 10: Commit**

```bash
git add showroom-backend/src/main/java/ar/com/leo/showroom/showroom/dto/CrearPedidoRequestDTO.java \
        showroom-backend/src/main/java/ar/com/leo/showroom/pedido/service/PedidoService.java \
        showroom-backend/src/main/java/ar/com/leo/showroom/presupuesto/dto/GenerarPresupuestoRequestDTO.java \
        showroom-backend/src/test/java/ar/com/leo/showroom/pedido/service/ResolverEsMaqTest.java
git commit -m "feat(pedido): congelar el perfil de IVA cotizado (precioReferenciaConIva) en pedidos de presupuesto"
```

---

### Task 2: Frontend — propagar `precioReferenciaConIva` por el dialog

**Files:**
- Modify: `showroom-frontend/src/app/showroom/models.ts` (`CrearPedidoRequest` item ~117-140)
- Modify: `showroom-frontend/src/app/showroom/crear-pedido-dialog/crear-pedido-dialog.ts` (signal shape ~178-188; mapeo desde `det.items` ~388-396; mapeo al request ~717-734)

**Interfaces:**
- Consumes: `CrearPedidoRequestDTO.Item.precioReferenciaConIva` (Task 1); `PresupuestoDetalle.items[].precioReferenciaConIva` (ya en `models.ts`).

- [ ] **Step 1: Agregar el campo al item de `CrearPedidoRequest` (models.ts)**

En `showroom-frontend/src/app/showroom/models.ts`, en el `items[]` de `CrearPedidoRequest` (el objeto con `sku`/`cantidad`/`precioUnitario`/`rubro`/`porcIva`/`comentarios`), agregar tras `comentarios`:

```typescript
    /** Perfil de IVA cotizado (true=menaje c/IVA, false=maquinaria s/IVA). En
     *  pedidos de presupuesto el backend congela el perfil con este flag. */
    precioReferenciaConIva?: boolean;
```

- [ ] **Step 2: Agregar el campo al shape del signal `itemsDelPresupuesto` (~188)**

En `crear-pedido-dialog.ts`, en el tipo del signal `itemsDelPresupuesto` (tras `comentarios: string | null;`):

```typescript
    /** Perfil de IVA con que se cotizó el ítem; el backend lo usa para congelar
     *  el perfil al crear el pedido. */
    precioReferenciaConIva: boolean | null;
```

- [ ] **Step 3: Poblar el flag desde `det.items` (~388-396)**

En el `this.itemsDelPresupuesto.set(det.items.map((it) => ({ ... })))`, agregar tras `comentarios`:

```typescript
          comentarios: it.comentarios ?? null,
          precioReferenciaConIva: it.precioReferenciaConIva ?? null,
        })));
```

(Reemplaza el cierre `comentarios: it.comentarios ?? null, })))` por el bloque con la línea nueva antes del `})))`.)

- [ ] **Step 4: Enviar el flag en el request del pedido (~717-734)**

En el `items: this.itemsDelPresupuesto().map((it) => ({ ... }))`, agregar tras `comentarios`:

```typescript
        comentarios: it.comentarios ?? undefined,
        precioReferenciaConIva: it.precioReferenciaConIva ?? undefined,
      })),
```

- [ ] **Step 5: Verificar el build**

Run: `cd showroom-frontend && npm run build`
Expected: build OK.

- [ ] **Step 6: Verificación manual (humano)**

Cotizar un presupuesto con un ítem de maquinaria (sin IVA). Cambiar la config de rubros sin IVA (sacar ese rubro). Convertir el presupuesto en pedido → el ítem se factura **sin IVA** (como se cotizó), no según la config nueva. Un pedido del showroom normal y un presupuesto viejo (sin flag) → perfil por rubro, como hoy.

- [ ] **Step 7: Commit**

```bash
git add showroom-frontend/src/app/showroom/models.ts \
        showroom-frontend/src/app/showroom/crear-pedido-dialog/crear-pedido-dialog.ts
git commit -m "feat(crear-pedido): enviar precioReferenciaConIva para congelar el perfil en pedidos de presupuesto"
```

---

## Notas de verificación final

- Backend: `mvn -f showroom-backend/pom.xml test` en verde (incluye `ResolverEsMaqTest`).
- Frontend: `cd showroom-frontend && npm run build` OK.
- Congelado solo en pedidos de presupuesto con flag; fallback por rubro en el resto.
- Ambos call-sites de `esMaq` (persistencia + payload DUX) usan el mismo helper → el ítem persistido y lo facturado a DUX coinciden.
