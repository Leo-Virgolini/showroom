# Historial: total y nombre de la forma elegida en la lista — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** En el historial de presupuestos, que la columna Total de la fila muestre el total en la forma de pago elegida (con badge del nombre) y que el detalle muestre "Forma de pago: {nombre}".

**Architecture:** El total y el nombre de la forma elegida se persisten en la entity al guardar (tomados del snapshot que ya manda el front, sin recalcular) y se exponen en el list DTO, para que la lista no tenga que deserializar las formas por fila. El frontend usa esos campos en la columna Total + badge; el detalle muestra el nombre con `formaSeleccionadaDe(det)` que ya existe.

**Tech Stack:** Spring Boot 4 + Java 25 (JPA/Lombok, record DTO), Angular 21 + PrimeNG (p-table), Tailwind. Tests: `mvn -f showroom-backend/pom.xml test`, `cd showroom-frontend && npm run build`.

## Global Constraints

- Columnas nuevas nullable, `ddl-auto` (sin migración manual). Null = "Todas".
- No recalcular el total de la forma: usar `precioFinal` del snapshot que manda el front (`datos.formasPago()`), buscando por `formaPagoSeleccionadaId`.
- No tocar `subtotalSinIva` persistido (sigue siendo Efectivo, base estable). No tocar el PDF ni el flujo de pedido. No retro-rellenar presupuestos viejos.
- "Todas" / presupuesto viejo sin estos campos ⇒ lista y detalle idénticos a hoy (columna en Efectivo, sin badge, sin línea de forma).

---

### Task 1: Backend — persistir y exponer total + nombre de la forma elegida (+ modelo TS)

**Files:**
- Modify: `showroom-backend/src/main/java/ar/com/leo/showroom/presupuesto/entity/PresupuestoComercial.java` (2 columnas, tras `formaPagoSeleccionadaId` ~99-100)
- Modify: `showroom-backend/src/main/java/ar/com/leo/showroom/presupuesto/service/PresupuestoComercialService.java` (`aplicarDatos` ~946; `toListItemDTO` ~712-726)
- Modify: `showroom-backend/src/main/java/ar/com/leo/showroom/presupuesto/dto/PresupuestoListItemDTO.java` (2 campos)
- Modify: `showroom-frontend/src/app/showroom/models.ts` (`PresupuestoListItem` ~837-859)

**Interfaces:**
- Produces: `PresupuestoComercial.getTotalFormaSeleccionada()/setTotalFormaSeleccionada(BigDecimal)`, `getFormaPagoSeleccionadaNombre()/setFormaPagoSeleccionadaNombre(String)` (Lombok); `PresupuestoListItemDTO.totalFormaSeleccionada()` / `formaPagoSeleccionadaNombre()` (record, últimos componentes); `PresupuestoListItem.totalFormaSeleccionada` / `formaPagoSeleccionadaNombre` (TS). Consumidos por Task 2.

- [ ] **Step 1: Agregar las 2 columnas a la entity**

En `PresupuestoComercial.java`, tras el campo `formaPagoSeleccionadaId` (~99-100), insertar:

```java
    /** Total del presupuesto en la forma de pago elegida (snapshot del
     *  `precioFinal` de esa forma al guardar). Null = "Todas" → la lista cae a
     *  `subtotalSinIva` (Efectivo). Se persiste para no deserializar las formas
     *  por fila en el listado. */
    @Column(name = "total_forma_seleccionada", precision = 18, scale = 2)
    private BigDecimal totalFormaSeleccionada;

    /** Nombre de la forma de pago elegida (para el badge de la lista). Null =
     *  "Todas". */
    @Column(name = "forma_pago_seleccionada_nombre", length = 100)
    private String formaPagoSeleccionadaNombre;
```

- [ ] **Step 2: Persistir total + nombre en `aplicarDatos`**

En `PresupuestoComercialService.aplicarDatos`, después de
`p.setFormaPagoSeleccionadaId(datos.formaPagoSeleccionadaId());` (~946), insertar:

```java
        // Total + nombre de la forma elegida (snapshot, para la lista). Se toma
        // del `precioFinal`/`nombre` que ya manda el front en `formasPago`,
        // buscando por el id elegido. Null cuando es "Todas".
        GenerarPresupuestoRequestDTO.FormaPagoSnapshot formaSel =
                (datos.formaPagoSeleccionadaId() != null && datos.formasPago() != null)
                        ? datos.formasPago().stream()
                                .filter(f -> datos.formaPagoSeleccionadaId().equals(f.id()))
                                .findFirst().orElse(null)
                        : null;
        p.setTotalFormaSeleccionada(formaSel != null ? formaSel.precioFinal() : null);
        p.setFormaPagoSeleccionadaNombre(formaSel != null ? formaSel.nombre() : null);
```

- [ ] **Step 3: Agregar los 2 campos al record `PresupuestoListItemDTO`**

En `PresupuestoListItemDTO.java`, agregar como últimos componentes (tras `convertidoAt`):

```java
        Long convertidoEnPedidoId,
        Instant convertidoAt,
        /** Total en la forma elegida (null = "Todas" → la lista muestra `totalSinIva`). */
        BigDecimal totalFormaSeleccionada,
        /** Nombre de la forma elegida para el badge (null = "Todas"). */
        String formaPagoSeleccionadaNombre
) {}
```

- [ ] **Step 4: Mapear los 2 campos en `toListItemDTO`**

En `PresupuestoComercialService.toListItemDTO` (~712-726), agregar los 2 argumentos finales al `new PresupuestoListItemDTO(...)`:

```java
                creadoPor,
                p.getConvertidoEnPedidoId(),
                p.getConvertidoAt(),
                p.getTotalFormaSeleccionada(),
                p.getFormaPagoSeleccionadaNombre());
```

- [ ] **Step 5: Agregar los 2 campos al modelo TS `PresupuestoListItem`**

En `showroom-frontend/src/app/showroom/models.ts`, dentro de `PresupuestoListItem` (tras `convertidoAt?`):

```typescript
  /** Total en la forma de pago elegida (null = "Todas" → mostrar `totalSinIva`). */
  totalFormaSeleccionada?: number | null;
  /** Nombre de la forma elegida para el badge de la fila (null = "Todas"). */
  formaPagoSeleccionadaNombre?: string | null;
```

- [ ] **Step 6: Compilar backend + suite + frontend**

Run: `mvn -f showroom-backend/pom.xml test 2>&1 | grep -E "Tests run: [0-9]+, Failures.*Skipped: [0-9]+$|BUILD"`
Expected: `BUILD SUCCESS`, 0 failures (el `new PresupuestoListItemDTO(...)` con los 2 args nuevos compila; único call-site es `toListItemDTO`).
Run: `cd showroom-frontend && npm run build`
Expected: build OK.

- [ ] **Step 7: Commit**

```bash
git add showroom-backend/src/main/java/ar/com/leo/showroom/presupuesto/entity/PresupuestoComercial.java \
        showroom-backend/src/main/java/ar/com/leo/showroom/presupuesto/service/PresupuestoComercialService.java \
        showroom-backend/src/main/java/ar/com/leo/showroom/presupuesto/dto/PresupuestoListItemDTO.java \
        showroom-frontend/src/app/showroom/models.ts
git commit -m "feat(presupuesto): persistir y exponer total+nombre de la forma elegida para la lista del historial"
```

---

### Task 2: Frontend — columna Total con total de forma + badge, y línea en el detalle

**Files:**
- Modify: `showroom-frontend/src/app/showroom/presupuestos-historial-page/presupuestos-historial-page.html` (celda Total ~157-159; bloque detalle tras "Cotización" ~301)

**Interfaces:**
- Consumes: `PresupuestoListItem.totalFormaSeleccionada` / `formaPagoSeleccionadaNombre` (Task 1); `formaSeleccionadaDe(det)` (ya existe en el componente).

- [ ] **Step 1: Columna Total — total de la forma + badge del nombre (HTML ~157-159)**

Reemplazar:

```html
            <td class="text-right text-sm font-bold text-[#3B1E09] dark:text-surface-0">
              {{ (p.totalSinIva ?? 0) | currency:'ARS':'symbol':'1.0-0' }}
            </td>
```

por:

```html
            <td class="text-right text-sm font-bold text-[#3B1E09] dark:text-surface-0">
              {{ (p.totalFormaSeleccionada ?? p.totalSinIva ?? 0) | currency:'ARS':'symbol':'1.0-0' }}
              @if (p.formaPagoSeleccionadaNombre) {
                <div class="text-[10px] font-semibold text-[#FF861C] mt-0.5"
                  [pTooltip]="'Total en ' + p.formaPagoSeleccionadaNombre" tooltipPosition="left">
                  {{ p.formaPagoSeleccionadaNombre }}
                </div>
              }
            </td>
```

- [ ] **Step 2: Detalle — línea "Forma de pago: {nombre}" tras "Cotización" (HTML ~301)**

Después de:

```html
                        <dt class="text-muted-color">Cotización</dt>
                        <dd>{{ det.cotizacionIndividual ? 'Individual (1 hoja por producto)' : 'Agregada' }}</dd>
```

insertar:

```html
                        @if (formaSeleccionadaDe(det); as fp) {
                          <dt class="text-muted-color">Forma de pago</dt>
                          <dd class="font-semibold text-[#3B1E09] dark:text-surface-0">{{ fp.nombre }}</dd>
                        }
```

- [ ] **Step 3: Verificar el build**

Run: `cd showroom-frontend && npm run build`
Expected: build OK (sin errores de template; `pTooltip` ya está disponible en este componente).

- [ ] **Step 4: Verificación manual (humano)**

- Crear/editar un presupuesto **con forma elegida** → en el historial, la columna Total de la fila muestra el total de esa forma + el nombre debajo; al expandir, "Forma de pago: X" y el mismo total.
- Un presupuesto **"Todas"** (o viejo sin los campos) → columna en Efectivo, sin badge, sin línea de forma — como hoy.

- [ ] **Step 5: Commit**

```bash
git add showroom-frontend/src/app/showroom/presupuestos-historial-page/presupuestos-historial-page.html
git commit -m "feat(presupuestos-historial): total de la forma + nombre en la fila y en el detalle"
```

---

## Notas de verificación final

- Backend: `mvn -f showroom-backend/pom.xml test` en verde.
- Frontend: `cd showroom-frontend && npm run build` OK.
- Con forma elegida: fila y detalle muestran el total de la forma + su nombre; coinciden.
- "Todas" / viejo: igual que hoy (Efectivo, sin badge/línea).
- El `subtotalSinIva` persistido y el flujo de pedido no cambian.
