# SKU como link + ícono de maquinaria en historiales — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** En las tablas de ítems de pedidos, presupuestos (historial) y atenciones (historial), hacer que el SKU sea un link al catálogo filtrado (en pestaña nueva) y mostrar un ícono de maquinaria (sin texto) en los ítems de rubro `MAQUINAS INDUSTRIALES`.

**Architecture:** Las 3 tablas son `p-table` anidadas en el row-expansion del registro; cada fila interna es un ítem con `it.sku`/`it.descripcion`. El SKU pasa a `<a [routerLink]="['/productos']" [queryParams]="{ q: it.sku }" target="_blank">` (productos ya filtra por `q`). El ícono usa el criterio existente `rubroExcluyeDescuentos(rubro)` de `models.ts`. Atenciones y presupuestos ya traen `rubro` por ítem; pedidos requiere persistirlo en el backend primero.

**Tech Stack:** Angular 21 + PrimeNG 21 (`p-table`, `pTooltip`, `RouterLink`), Tailwind v4; backend Spring Boot 4 + Java 25 (Lombok, JPA). Tests: `mvn -f showroom-backend/pom.xml test`, `cd showroom-frontend && npm run build`.

## Global Constraints

- Criterio de maquinaria: reusar `rubroExcluyeDescuentos(rubro)` de `showroom-frontend/src/app/showroom/models.ts` (lista `RUBROS_SIN_DESCUENTO_ESCALA = {'MAQUINAS INDUSTRIALES'}`). NO duplicar la lógica ni hardcodear el string en los componentes.
- Ícono: `pi pi-wrench` ámbar (`text-amber-600 dark:text-amber-400`), **solo el ícono** (sin texto del rubro), con `pTooltip="Maquinaria · MAQUINAS INDUSTRIALES"`, ubicado **antes** del texto de la descripción.
- SKU-link: `[routerLink]="['/productos']" [queryParams]="{ q: it.sku }" target="_blank" rel="noopener"`, clase `font-mono text-sm text-primary hover:underline`, `pTooltip="Ver en el catálogo"`. Abre en **pestaña nueva**.
- PrimeNG: usar atributo `class`, no `styleClass`.
- Pedidos creados antes del cambio tienen `rubro = NULL` → sin ícono, sin romper. Columna nullable vía `ddl-auto`, sin migración manual.
- En pedidos se persiste el rubro **del ítem** (`it.rubro()` del request), no el `rubroItem` con fallback al rubro del cliente.
- Las 3 tablas son: pedidos, presupuestos (historial), atenciones (historial). El SKU-link va en las 3; el ícono también en las 3 (pedidos habilitado por la Task 1).

---

### Task 1: Persistir el rubro del ítem de pedido (backend + modelo TS)

Habilita el ícono de maquinaria en la tabla de pedidos (Task 4). El rubro ya está disponible en `crearPedido` (`it.rubro()`), solo falta guardarlo y exponerlo.

**Files:**
- Modify: `showroom-backend/src/main/java/ar/com/leo/showroom/pedido/entity/PedidoShowroomItem.java` (nueva columna, tras `descripcion` ~línea 33)
- Modify: `showroom-backend/src/main/java/ar/com/leo/showroom/showroom/dto/PedidoItemDTO.java` (nuevo campo)
- Modify: `showroom-backend/src/main/java/ar/com/leo/showroom/pedido/service/PedidoService.java` (builder del ítem ~588-598; mapeo entity→DTO ~294-303)
- Modify: `showroom-frontend/src/app/showroom/models.ts` (`PedidoItemDetalle` ~641-662)

**Interfaces:**
- Produces: `PedidoShowroomItem.getRubro()` / `setRubro(String)` (Lombok); `PedidoItemDTO.rubro()` (record component, posición final); `PedidoItemDetalle.rubro: string | null` (TS). Consumido por Task 4.

- [ ] **Step 1: Agregar la columna `rubro` a la entity**

En `PedidoShowroomItem.java`, tras el campo `descripcion` (línea ~33), insertar:

```java
    /** Rubro DUX del producto al momento del pedido (snapshot). Se usa para
     *  marcar visualmente los ítems de maquinaria (MAQUINAS INDUSTRIALES) en la
     *  tabla de pedidos. Null en pedidos anteriores a esta columna. */
    @Column(name = "rubro", length = 150)
    private String rubro;
```

- [ ] **Step 2: Persistir el rubro al crear el pedido**

En `PedidoService.java`, en el `PedidoShowroomItem.builder()` de `crearPedido` (líneas ~588-598), agregar `.rubro(it.rubro())` (el rubro del ítem del request, no `rubroItem`). Queda:

```java
            PedidoShowroomItem item = PedidoShowroomItem.builder()
                    .pedido(pedido)
                    .sku(it.sku())
                    .descripcion(descripcion)
                    .rubro(it.rubro())
                    .cantidad(it.cantidad())
                    .precioUnitario(precioFinal)
                    .porcIva(porcIva)
                    .aplicaIva(aplicaIvaItem)
                    .descuentoPorcentaje(descItem.signum() > 0 ? descItem : null)
                    .comentarios(StringUtils.hasText(it.comentarios()) ? it.comentarios().trim() : null)
                    .build();
```

- [ ] **Step 3: Agregar el campo `rubro` al record `PedidoItemDTO`**

En `PedidoItemDTO.java`, agregar el componente al final del record (tras `comentarios`):

```java
public record PedidoItemDTO(
        String sku,
        String descripcion,
        Integer cantidad,
        /** Precio unitario CON IVA — el que se envió a DUX. */
        BigDecimal precioUnitario,
        /** % de IVA aplicado en el momento del pedido. Null para pedidos viejos. */
        BigDecimal porcIva,
        /** Si el {@code precioUnitario} lleva IVA (lo decide el perfil del rubro
         *  del ítem). Null para pedidos anteriores a esta columna → el frontend
         *  cae al flag global {@code formaPagoAplicaIva}. */
        Boolean aplicaIva,
        /** % de descuento de la línea (lo que se mandó a DUX como porc_desc). El
         *  {@code precioUnitario} es BRUTO; el frontend deriva el subtotal neto
         *  aplicando este %. Null = sin descuento (incluye pedidos viejos). */
        BigDecimal descuentoPorcentaje,
        /** URL del endpoint local que sirve la imagen del producto, o null si no
         *  hay archivo. Se calcula al leer el pedido (no se persiste con el item). */
        String imagenUrl,
        /** Comentarios libres que viajaron como {@code comentarios} de la línea
         *  al payload DUX. Usado para describir productos genéricos cargados
         *  con el SKU comodín. Null en líneas de producto del catálogo. */
        String comentarios,
        /** Rubro DUX del producto (snapshot del pedido). Para marcar maquinaria
         *  en la tabla. Null en pedidos anteriores a esta columna. */
        String rubro
) {
}
```

- [ ] **Step 4: Mapear el rubro al leer el pedido**

En `PedidoService.java` (mapeo ~294-303), agregar `it.getRubro()` como último argumento del `new PedidoItemDTO(...)`:

```java
        List<PedidoItemDTO> items = p.getItems().stream()
                .map(it -> new PedidoItemDTO(
                        it.getSku(),
                        it.getDescripcion(),
                        it.getCantidad(),
                        it.getPrecioUnitario(),
                        it.getPorcIva(),
                        it.getAplicaIva(),
                        it.getDescuentoPorcentaje(),
                        imagenLocalService.urlPublica(it.getSku()),
                        it.getComentarios(),
                        it.getRubro()))
                .toList();
```

- [ ] **Step 5: Agregar `rubro` al modelo TS `PedidoItemDetalle`**

En `showroom-frontend/src/app/showroom/models.ts`, dentro de `PedidoItemDetalle` (tras `comentarios?`, ~línea 661), agregar:

```typescript
  /** Rubro DUX del producto (snapshot del pedido). Para marcar maquinaria en la
   *  tabla. Null en pedidos anteriores a esta columna. */
  rubro?: string | null;
```

- [ ] **Step 6: Compilar el backend**

Run: `mvn -f showroom-backend/pom.xml -q -DskipTests compile`
Expected: BUILD SUCCESS (confirma que el record, la entity y los 2 call-sites compilan).

- [ ] **Step 7: Correr la suite backend (no debe romper nada)**

Run: `mvn -f showroom-backend/pom.xml test 2>&1 | grep -E "Tests run: [0-9]+, Failures.*Skipped: [0-9]+$|BUILD"`
Expected: `BUILD SUCCESS`, 0 failures (los tests existentes siguen verdes; el nuevo campo es opcional y no afecta los DTOs deserializados).

- [ ] **Step 8: Compilar el frontend**

Run: `cd showroom-frontend && npm run build`
Expected: build OK.

- [ ] **Step 9: Commit**

```bash
git add showroom-backend/src/main/java/ar/com/leo/showroom/pedido/entity/PedidoShowroomItem.java \
        showroom-backend/src/main/java/ar/com/leo/showroom/showroom/dto/PedidoItemDTO.java \
        showroom-backend/src/main/java/ar/com/leo/showroom/pedido/service/PedidoService.java \
        showroom-frontend/src/app/showroom/models.ts
git commit -m "feat(pedido): persistir y exponer el rubro del ítem (para marcar maquinaria)"
```

---

### Task 2: SKU-link + ícono de maquinaria en Atenciones (historial)

**Files:**
- Modify: `showroom-frontend/src/app/showroom/historial-page/historial-page.html` (celda SKU ~409, celda descripción ~410)
- Modify: `showroom-frontend/src/app/showroom/historial-page/historial-page.ts` (imports + helper)

**Interfaces:**
- Consumes: `rubroExcluyeDescuentos` de `models.ts`; `SesionScanItem.rubro` (ya existe). El ítem del template es `it` (`let-it`) con `it.sku`, `it.descripcion`, `it.rubro`.
- Produces: patrón de SKU-link + ícono replicado en Tasks 3 y 4.

- [ ] **Step 1: Exponer el helper de maquinaria en el componente**

En `historial-page.ts`, en el import desde `../models` (o `'../models'`/`'./...'` según el path existente del componente; buscar la línea `from './...models'` o agregar uno), agregar `rubroExcluyeDescuentos`. Luego, dentro de la clase del componente, agregar:

```typescript
  /** Marca de maquinaria (MAQUINAS INDUSTRIALES) — mismo criterio que la tabla
   *  de productos. Se usa para el ícono pi-wrench en la tabla de ítems. */
  protected readonly esRubroMaquinaria = rubroExcluyeDescuentos;
```

Si el componente aún no importa `RouterLink` de `@angular/router`, agregarlo al import y al array `imports: [...]` del decorador `@Component` (este componente ya usa `[routerLink]` en otras celdas, así que normalmente ya está; verificar y agregar solo si falta).

- [ ] **Step 2: Convertir el SKU en link (celda ~409)**

Reemplazar:

```html
                    <td class="font-mono text-sm">{{ it.sku }}</td>
```

por:

```html
                    <td>
                      <a [routerLink]="['/productos']" [queryParams]="{ q: it.sku }"
                         target="_blank" rel="noopener"
                         class="font-mono text-sm text-primary hover:underline"
                         pTooltip="Ver en el catálogo" tooltipPosition="top">
                        {{ it.sku }}
                      </a>
                    </td>
```

- [ ] **Step 3: Agregar el ícono de maquinaria antes de la descripción (celda ~410)**

Reemplazar:

```html
                    <td>{{ it.descripcion ?? '—' }}</td>
```

por:

```html
                    <td>
                      @if (esRubroMaquinaria(it.rubro)) {
                        <i class="pi pi-wrench text-amber-600 dark:text-amber-400 mr-1 text-[0.7rem]"
                           pTooltip="Maquinaria · MAQUINAS INDUSTRIALES" tooltipPosition="top"></i>
                      }
                      {{ it.descripcion ?? '—' }}
                    </td>
```

- [ ] **Step 4: Compilar el frontend**

Run: `cd showroom-frontend && npm run build`
Expected: build OK (sin errores de template; `RouterLink`/`pTooltip` resueltos).

- [ ] **Step 5: Verificación manual (humano)**

En `/historial`, expandir una sesión con ítems: el SKU es un link que abre `/productos?q=SKU` en pestaña nueva; un ítem de rubro `MAQUINAS INDUSTRIALES` muestra el `pi-wrench` antes de la descripción; otro rubro no.

- [ ] **Step 6: Commit**

```bash
git add showroom-frontend/src/app/showroom/historial-page/historial-page.html \
        showroom-frontend/src/app/showroom/historial-page/historial-page.ts
git commit -m "feat(historial): SKU como link al catálogo + ícono de maquinaria"
```

---

### Task 3: SKU-link + ícono de maquinaria en Presupuestos (historial)

**Files:**
- Modify: `showroom-frontend/src/app/showroom/presupuestos-historial-page/presupuestos-historial-page.html` (celda SKU ~346, celda descripción ~347)
- Modify: `showroom-frontend/src/app/showroom/presupuestos-historial-page/presupuestos-historial-page.ts` (imports + helper)

**Interfaces:**
- Consumes: `rubroExcluyeDescuentos` de `models.ts`; el ítem del detalle (`PresupuestoDetalle.items`) ya tiene `rubro?: string | null`. El ítem del template es `it` (`let-it`) con `it.sku`, `it.descripcion`, `it.rubro`.

- [ ] **Step 1: Exponer el helper de maquinaria en el componente**

En `presupuestos-historial-page.ts`, agregar `rubroExcluyeDescuentos` al import desde `../models`. Dentro de la clase, agregar:

```typescript
  /** Marca de maquinaria (MAQUINAS INDUSTRIALES) — mismo criterio que productos. */
  protected readonly esRubroMaquinaria = rubroExcluyeDescuentos;
```

Verificar que `RouterLink` de `@angular/router` esté en el import y en `imports: [...]` del `@Component`; si falta (este componente navega con `router.navigate`, puede no tener `RouterLink`), agregarlo.

- [ ] **Step 2: Convertir el SKU en link (celda ~346)**

Reemplazar:

```html
                          <td class="font-mono text-sm">{{ it.sku }}</td>
```

por:

```html
                          <td>
                            <a [routerLink]="['/productos']" [queryParams]="{ q: it.sku }"
                               target="_blank" rel="noopener"
                               class="font-mono text-sm text-primary hover:underline"
                               pTooltip="Ver en el catálogo" tooltipPosition="top">
                              {{ it.sku }}
                            </a>
                          </td>
```

- [ ] **Step 3: Agregar el ícono de maquinaria antes de la descripción (celda ~347)**

Reemplazar:

```html
                          <td>{{ it.descripcion ?? '—' }}</td>
```

por:

```html
                          <td>
                            @if (esRubroMaquinaria(it.rubro)) {
                              <i class="pi pi-wrench text-amber-600 dark:text-amber-400 mr-1 text-[0.7rem]"
                                 pTooltip="Maquinaria · MAQUINAS INDUSTRIALES" tooltipPosition="top"></i>
                            }
                            {{ it.descripcion ?? '—' }}
                          </td>
```

- [ ] **Step 4: Compilar el frontend**

Run: `cd showroom-frontend && npm run build`
Expected: build OK.

- [ ] **Step 5: Verificación manual (humano)**

En `/presupuestos/historial`, expandir un presupuesto: el SKU abre `/productos?q=SKU` en pestaña nueva; los ítems de maquinaria muestran el ícono.

- [ ] **Step 6: Commit**

```bash
git add showroom-frontend/src/app/showroom/presupuestos-historial-page/presupuestos-historial-page.html \
        showroom-frontend/src/app/showroom/presupuestos-historial-page/presupuestos-historial-page.ts
git commit -m "feat(presupuestos-historial): SKU como link al catálogo + ícono de maquinaria"
```

---

### Task 4: SKU-link + ícono de maquinaria en Pedidos

Depende de Task 1 (el ítem de pedido ahora trae `rubro`).

**Files:**
- Modify: `showroom-frontend/src/app/showroom/pedidos-page/pedidos-page.html` (celda SKU ~518, celda descripción ~519)
- Modify: `showroom-frontend/src/app/showroom/pedidos-page/pedidos-page.ts` (imports + helper)

**Interfaces:**
- Consumes: `rubroExcluyeDescuentos` de `models.ts`; `PedidoItemDetalle.rubro` (agregado en Task 1). El ítem del template es `it` (`let-it`) con `it.sku`, `it.descripcion`, `it.rubro`.

- [ ] **Step 1: Exponer el helper de maquinaria en el componente**

En `pedidos-page.ts`, agregar `rubroExcluyeDescuentos` al import desde `../models`. Dentro de la clase, agregar:

```typescript
  /** Marca de maquinaria (MAQUINAS INDUSTRIALES) — mismo criterio que productos. */
  protected readonly esRubroMaquinaria = rubroExcluyeDescuentos;
```

`RouterLink` ya está en uso en este componente (celdas "Presupuesto #" / "Sesión #"), así que normalmente ya está importado; verificar y agregar solo si falta.

- [ ] **Step 2: Convertir el SKU en link (celda ~518)**

Reemplazar:

```html
                          <td class="font-mono text-sm">{{ it.sku }}</td>
```

por:

```html
                          <td>
                            <a [routerLink]="['/productos']" [queryParams]="{ q: it.sku }"
                               target="_blank" rel="noopener"
                               class="font-mono text-sm text-primary hover:underline"
                               pTooltip="Ver en el catálogo" tooltipPosition="top">
                              {{ it.sku }}
                            </a>
                          </td>
```

- [ ] **Step 3: Agregar el ícono de maquinaria antes de la descripción (celda ~519)**

Reemplazar:

```html
                          <td>{{ it.descripcion ?? '—' }}</td>
```

por:

```html
                          <td>
                            @if (esRubroMaquinaria(it.rubro)) {
                              <i class="pi pi-wrench text-amber-600 dark:text-amber-400 mr-1 text-[0.7rem]"
                                 pTooltip="Maquinaria · MAQUINAS INDUSTRIALES" tooltipPosition="top"></i>
                            }
                            {{ it.descripcion ?? '—' }}
                          </td>
```

- [ ] **Step 4: Compilar el frontend**

Run: `cd showroom-frontend && npm run build`
Expected: build OK.

- [ ] **Step 5: Verificación manual (humano)**

En `/pedidos`, expandir un pedido NUEVO (creado tras la Task 1) con un ítem de maquinaria: el SKU abre `/productos?q=SKU` en pestaña nueva y el ítem de maquinaria muestra el ícono. Un pedido viejo (rubro NULL) no muestra ícono y no rompe.

- [ ] **Step 6: Commit**

```bash
git add showroom-frontend/src/app/showroom/pedidos-page/pedidos-page.html \
        showroom-frontend/src/app/showroom/pedidos-page/pedidos-page.ts
git commit -m "feat(pedidos): SKU como link al catálogo + ícono de maquinaria"
```

---

## Notas de verificación final (tras todas las tareas)

- Backend: `mvn -f showroom-backend/pom.xml test` en verde.
- Frontend: `cd showroom-frontend && npm run build` OK.
- Las 3 tablas: SKU es link a `/productos?q=SKU` en pestaña nueva; ícono `pi-wrench` solo en ítems `MAQUINAS INDUSTRIALES`, antes de la descripción.
- Pedidos viejos sin rubro: no muestran ícono y no rompen el render.
- El criterio de maquinaria sale de `rubroExcluyeDescuentos` (una sola fuente), no de strings duplicados en los componentes.
