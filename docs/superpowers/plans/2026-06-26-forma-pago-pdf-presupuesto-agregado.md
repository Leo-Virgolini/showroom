# Selección de forma de pago en PDF de presupuesto agregado — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permitir elegir una forma de pago al generar el PDF de un presupuesto *agregado*, de modo que el precio por ítem, el total y sus etiquetas se expresen en esa forma; con la opción "Todas" (default) el PDF queda idéntico al actual.

**Architecture:** El frontend agrega un selector "Forma de pago" en la toolbar (solo modo Agregado, "Todas" por default) y manda su `id` en el request. El backend resuelve el snapshot elegido desde la lista de formas ya enviadas y reescribe la tabla/total reusando el calculador de precios existente (`PrecioPerfilCalculator.calcularPrecioFinal`), ocultando la sección de cards comparativas. La forma elegida se persiste en la entity para regenerar el PDF idéntico desde el historial.

**Tech Stack:** Backend Spring Boot 4 + Java 25 (Jackson 3 en `tools.jackson`, Lombok), iText para PDF, JUnit 5 + AssertJ + Mockito para tests. Frontend Angular 21 + PrimeNG 21 (`p-select`).

## Global Constraints

- Jackson 3: campos opcionales en records/DTOs = **wrapper** (`Long`, `Boolean`), nunca primitivo (`FAIL_ON_NULL_FOR_PRIMITIVES` es true por default). Usar `Long` para el nuevo campo.
- PrimeNG: usar atributo `class`, **no** `styleClass` (deprecated v17+).
- No tocar la lista KT GASTRO ni precios en DUX (read-only).
- El cálculo de precio por forma DEBE reusar `PrecioPerfilCalculator.calcularPrecioFinal(precioBaseConIva, porcIva, recargo, aplicaIva)` y `PrecioPerfilCalculator.esMaquinaria(rubro, rubrosMaq)` — no reimplementar la fórmula (recargo >0 financia `÷(1−r)`, <0 descuenta `×(1+r)`).
- Tests del proyecto: unitarios puros (sin `@SpringBootTest`). Correr un test backend: `mvn -f showroom-backend/pom.xml -q -Dtest=Clase#metodo test`.
- "Todas" (sin forma elegida) ⇒ comportamiento byte-equivalente al actual. Nunca romper presupuestos viejos.
- **Orden del record `GenerarPresupuestoRequestDTO`**: el nuevo campo `formaPagoSeleccionadaId` va **entre `cotizacionIndividual` e `items`**. Todos los `new GenerarPresupuestoRequestDTO(...)` posicionales deben pasar el argumento en esa posición (hay 4 call-sites; Task 1 los cubre todos).

---

### Task 1: Campo `formaPagoSeleccionadaId` en DTO + entity + persistencia + modelo TS

Tarea fundacional: agrega el componente al record y, en el mismo paso, repara **todos** los call-sites posicionales y la persistencia, para que el módulo compile de una. Sin esto el resto no compila.

**Files:**
- Modify: `showroom-backend/src/main/java/ar/com/leo/showroom/presupuesto/dto/GenerarPresupuestoRequestDTO.java:46` (campo nuevo tras `cotizacionIndividual`)
- Modify: `showroom-backend/src/main/java/ar/com/leo/showroom/presupuesto/entity/PresupuestoComercial.java:93` (columna nueva)
- Modify: `showroom-backend/src/main/java/ar/com/leo/showroom/presupuesto/service/PresupuestoComercialService.java` (`aplicarDatos` ~946, `rehidratarDatos` 691-700, `forzarModoAgregado` 598-601, `forzarModoIndividual` 649-652)
- Modify: `showroom-backend/src/main/java/ar/com/leo/showroom/presupuesto/service/PresupuestoComercialPdfGenerator.java:389-391` (call-site del PDF "ítems de interés")
- Modify: `showroom-frontend/src/app/showroom/models.ts:796` (campo en `GenerarPresupuestoRequest`)
- Test: `showroom-backend/src/test/java/ar/com/leo/showroom/presupuesto/dto/GenerarPresupuestoRequestDTODeserializationTest.java` (crear)

**Interfaces:**
- Produces: `GenerarPresupuestoRequestDTO.formaPagoSeleccionadaId()` → `Long` (nullable; null = "Todas"). Consumido por Tasks 2-3.
- Produces: `PresupuestoComercial.getFormaPagoSeleccionadaId()` / `setFormaPagoSeleccionadaId(Long)` (Lombok `@Data`).
- Produces (TS): `formaPagoSeleccionadaId?: number | null` en `GenerarPresupuestoRequest`. Consumido por Task 4.

- [ ] **Step 1: Escribir el test de deserialización que falla**

Crear `showroom-backend/src/test/java/ar/com/leo/showroom/presupuesto/dto/GenerarPresupuestoRequestDTODeserializationTest.java`:

```java
package ar.com.leo.showroom.presupuesto.dto;

import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * El campo opcional {@code formaPagoSeleccionadaId} debe tolerar ausencia/null
 * (presupuestos en modo "Todas") y respetar el id cuando viene poblado.
 */
class GenerarPresupuestoRequestDTODeserializationTest {

    private final JsonMapper mapper = JsonMapper.builder().build();

    private static final String SIN_FORMA = """
            {"items":[{"sku":"1011002","cantidad":1,"precioConIva":1000}],
             "formasPago":[]}
            """;

    @Test
    void ausente_se_deserializa_como_null() {
        GenerarPresupuestoRequestDTO dto = mapper.readValue(SIN_FORMA, GenerarPresupuestoRequestDTO.class);
        assertThat(dto.formaPagoSeleccionadaId())
                .as("ausente ⇒ null (modo Todas)")
                .isNull();
    }

    @Test
    void id_explicito_se_respeta() {
        String json = """
                {"formaPagoSeleccionadaId":7,
                 "items":[{"sku":"1","cantidad":1,"precioConIva":1000}],
                 "formasPago":[]}
                """;
        GenerarPresupuestoRequestDTO dto = mapper.readValue(json, GenerarPresupuestoRequestDTO.class);
        assertThat(dto.formaPagoSeleccionadaId()).isEqualTo(7L);
    }
}
```

- [ ] **Step 2: Correr el test y verificar que falla a compilar**

Run: `mvn -f showroom-backend/pom.xml -q -Dtest=GenerarPresupuestoRequestDTODeserializationTest test`
Expected: FAIL — "cannot find symbol: method formaPagoSeleccionadaId()".

- [ ] **Step 3: Agregar el campo al record DTO**

En `GenerarPresupuestoRequestDTO.java`, tras `Boolean cotizacionIndividual,` (línea 46) y antes de `@NotEmpty ... List<Item> items,`, insertar:

```java
        /** Id de la forma de pago elegida para expresar TODO el presupuesto
         *  agregado en esa forma (precio por ítem + total + etiquetas). Null =
         *  "Todas": el PDF muestra el precio efectivo por ítem y la sección
         *  comparativa de formas, como históricamente. Solo aplica al modo
         *  agregado; en cotización individual se ignora. El backend resuelve el
         *  snapshot correspondiente desde {@link #formasPago()} por este id. */
        Long formaPagoSeleccionadaId,
```

- [ ] **Step 4: Agregar la columna a la entity**

En `PresupuestoComercial.java`, tras el campo `descuentoGlobalPorcentaje` (línea 93), insertar:

```java
    /** Id de la forma de pago con la que se expresó el presupuesto agregado.
     *  Null = "Todas" (precio efectivo por ítem + sección comparativa de
     *  formas, comportamiento histórico). Se persiste para regenerar el PDF
     *  idéntico desde el historial. No aplica a cotización individual. */
    @Column(name = "forma_pago_seleccionada_id")
    private Long formaPagoSeleccionadaId;
```

(Columna nullable; con `ddl-auto` se agrega sin migración y los registros viejos quedan en NULL = "Todas".)

- [ ] **Step 5: Setear el campo en `aplicarDatos`**

En `PresupuestoComercialService.aplicarDatos(...)`, junto a los `p.set...` (tras `p.setDescuentoGlobalPorcentaje(descGlobal);`, línea 946), insertar:

```java
        p.setFormaPagoSeleccionadaId(datos.formaPagoSeleccionadaId());
```

- [ ] **Step 6: Pasar el campo en los 4 call-sites posicionales del record**

(a) `rehidratarDatos(...)` (líneas 691-700) — usar el getter de la entity, posición entre `individual` e `items`:

```java
        return new GenerarPresupuestoRequestDTO(
                p.getClienteNombre(),
                p.getClienteTelefono(),
                p.getClienteEmail(),
                p.getRubro(),
                p.getObservaciones(),
                p.getDescuentoGlobalPorcentaje(),
                individual,
                p.getFormaPagoSeleccionadaId(),
                items == null ? List.of() : items,
                formas == null ? List.of() : formas);
```

(b) `forzarModoAgregado(...)` (líneas 598-601) — preserva la forma elegida:

```java
        return new GenerarPresupuestoRequestDTO(
                datos.clienteNombre(), datos.clienteTelefono(), datos.clienteEmail(),
                datos.rubro(), datos.observaciones(), datos.descuentoGlobalPorcentaje(),
                false, datos.formaPagoSeleccionadaId(), datos.items(), formasAgregadas);
```

(c) `forzarModoIndividual(...)` (líneas 649-652) — descarta la forma elegida (no aplica a individual):

```java
        return new GenerarPresupuestoRequestDTO(
                datos.clienteNombre(), datos.clienteTelefono(), datos.clienteEmail(),
                datos.rubro(), datos.observaciones(), datos.descuentoGlobalPorcentaje(),
                // En individual el id de forma elegida no aplica (cada ítem
                // lista sus propias formas) — se descarta.
                true, null, datos.items(), formasIndividuales);
```

(d) `PresupuestoComercialPdfGenerator.java` líneas 389-391 (PDF de "ítems de interés", siempre "Todas") — pasar `null` en la nueva posición:

```java
        GenerarPresupuestoRequestDTO datos = new GenerarPresupuestoRequestDTO(
                clienteNombre, null, null, null, null,
                BigDecimal.ZERO, Boolean.FALSE, null, items, List.of());
```

- [ ] **Step 7: Correr el test y verificar que pasa (confirma que todo compila)**

Run: `mvn -f showroom-backend/pom.xml -q -Dtest=GenerarPresupuestoRequestDTODeserializationTest test`
Expected: PASS (2 tests). Si falla a compilar, revisar que los 4 call-sites del Step 6 tengan el argumento en la posición correcta.

- [ ] **Step 8: Agregar el campo al modelo TS**

En `showroom-frontend/src/app/showroom/models.ts`, dentro de `GenerarPresupuestoRequest`, tras `cotizacionIndividual?: boolean;` (línea 796), insertar:

```typescript
  /** Id de la forma de pago elegida para el PDF agregado. null/undefined =
   *  "Todas" (precio efectivo por ítem + sección de formas comparativas, como
   *  hoy). Solo aplica al modo agregado; en individual el backend lo ignora. */
  formaPagoSeleccionadaId?: number | null;
```

- [ ] **Step 9: Verificar el typecheck del frontend**

Run: `cd showroom-frontend && npm run build`
Expected: build OK.

- [ ] **Step 10: Commit**

```bash
git add showroom-backend/src/main/java/ar/com/leo/showroom/presupuesto/dto/GenerarPresupuestoRequestDTO.java \
        showroom-backend/src/main/java/ar/com/leo/showroom/presupuesto/entity/PresupuestoComercial.java \
        showroom-backend/src/main/java/ar/com/leo/showroom/presupuesto/service/PresupuestoComercialService.java \
        showroom-backend/src/main/java/ar/com/leo/showroom/presupuesto/service/PresupuestoComercialPdfGenerator.java \
        showroom-backend/src/test/java/ar/com/leo/showroom/presupuesto/dto/GenerarPresupuestoRequestDTODeserializationTest.java \
        showroom-frontend/src/app/showroom/models.ts
git commit -m "feat(presupuesto): campo persistido formaPagoSeleccionadaId en DTO/entity + modelo TS"
```

---

### Task 2: Helpers puros de forma elegida y etiquetas (backend, TDD)

**Files:**
- Modify: `showroom-backend/src/main/java/ar/com/leo/showroom/presupuesto/service/PresupuestoComercialPdfGenerator.java` (métodos estáticos package-private, ubicarlos tras `agregarTotalesAgregado`, ~línea 811)
- Test: `showroom-backend/src/test/java/ar/com/leo/showroom/presupuesto/service/PresupuestoComercialPdfFormaElegidaTest.java` (crear)

**Interfaces:**
- Consumes: `GenerarPresupuestoRequestDTO.FormaPagoSnapshot` (record existente).
- Produces (todos `static`, package-private, en `PresupuestoComercialPdfGenerator`):
  - `FormaPagoSnapshot resolverFormaElegida(List<FormaPagoSnapshot> formas, Long id)` → la forma con ese id, o `null` (id null / lista null / no encontrada).
  - `String etiquetaColumnaPrecio(FormaPagoSnapshot elegida)` → `"PRECIO EFECTIVO"` / `"PRECIO " + nombre` MAYÚSCULAS.
  - `String etiquetaSubtotal(FormaPagoSnapshot elegida)` → `"Subtotal efectivo"` / `"Subtotal " + nombre`.
  - `String etiquetaTotal(FormaPagoSnapshot elegida)` → `"Total efectivo"` / `"Total " + nombre`.
  - `BigDecimal recargoDe(FormaPagoSnapshot f, boolean esMaq)` → recargo del perfil (fallback 0).
  - `boolean aplicaIvaDe(FormaPagoSnapshot f, boolean esMaq)` → IVA del perfil.
  - Consumidas por Task 3.

- [ ] **Step 1: Escribir los tests que fallan**

Crear `showroom-backend/src/test/java/ar/com/leo/showroom/presupuesto/service/PresupuestoComercialPdfFormaElegidaTest.java`:

```java
package ar.com.leo.showroom.presupuesto.service;

import ar.com.leo.showroom.presupuesto.dto.GenerarPresupuestoRequestDTO.FormaPagoSnapshot;
import org.junit.jupiter.api.Test;

import java.math.BigDecimal;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class PresupuestoComercialPdfFormaElegidaTest {

    /** Constructor del record (11 args, en orden):
     *  id, nombre, recargoPorcentaje, cantidadCuotas, aplicaIva, precioFinal,
     *  descripcion, monedaSimbolo, itemSku, recargoPorcentajeMaquinaria, aplicaIvaMaquinaria. */
    private static FormaPagoSnapshot forma(Long id, String nombre, BigDecimal recargo,
                                           Boolean aplicaIva, BigDecimal recargoMaq, Boolean aplicaIvaMaq) {
        return new FormaPagoSnapshot(id, nombre, recargo, 1, aplicaIva,
                BigDecimal.ZERO, null, null, null, recargoMaq, aplicaIvaMaq);
    }

    @Test
    void resolverFormaElegida_idNull_devuelveNull() {
        var f = forma(7L, "Transferencia", BigDecimal.ZERO, true, null, null);
        assertThat(PresupuestoComercialPdfGenerator.resolverFormaElegida(List.of(f), null)).isNull();
    }

    @Test
    void resolverFormaElegida_idDesconocido_devuelveNull() {
        var f = forma(7L, "Transferencia", BigDecimal.ZERO, true, null, null);
        assertThat(PresupuestoComercialPdfGenerator.resolverFormaElegida(List.of(f), 99L)).isNull();
    }

    @Test
    void resolverFormaElegida_encuentraPorId() {
        var f = forma(7L, "Transferencia", BigDecimal.ZERO, true, null, null);
        assertThat(PresupuestoComercialPdfGenerator.resolverFormaElegida(List.of(f), 7L)).isSameAs(f);
    }

    @Test
    void etiquetas_sinForma_usanEfectivo() {
        assertThat(PresupuestoComercialPdfGenerator.etiquetaColumnaPrecio(null)).isEqualTo("PRECIO EFECTIVO");
        assertThat(PresupuestoComercialPdfGenerator.etiquetaSubtotal(null)).isEqualTo("Subtotal efectivo");
        assertThat(PresupuestoComercialPdfGenerator.etiquetaTotal(null)).isEqualTo("Total efectivo");
    }

    @Test
    void etiquetas_conForma_usanNombre() {
        var f = forma(7L, "Transferencia", BigDecimal.ZERO, true, null, null);
        assertThat(PresupuestoComercialPdfGenerator.etiquetaColumnaPrecio(f)).isEqualTo("PRECIO TRANSFERENCIA");
        assertThat(PresupuestoComercialPdfGenerator.etiquetaSubtotal(f)).isEqualTo("Subtotal Transferencia");
        assertThat(PresupuestoComercialPdfGenerator.etiquetaTotal(f)).isEqualTo("Total Transferencia");
    }

    @Test
    void perfilMenaje_usaRecargoYAplicaIvaBase() {
        var f = forma(7L, "Crédito", new BigDecimal("15"), true, new BigDecimal("20"), false);
        assertThat(PresupuestoComercialPdfGenerator.recargoDe(f, false)).isEqualByComparingTo("15");
        assertThat(PresupuestoComercialPdfGenerator.aplicaIvaDe(f, false)).isTrue();
    }

    @Test
    void perfilMaquinaria_usaRecargoYAplicaIvaMaquinaria() {
        var f = forma(7L, "Crédito", new BigDecimal("15"), true, new BigDecimal("20"), false);
        assertThat(PresupuestoComercialPdfGenerator.recargoDe(f, true)).isEqualByComparingTo("20");
        assertThat(PresupuestoComercialPdfGenerator.aplicaIvaDe(f, true)).isFalse();
    }

    @Test
    void perfilMaquinaria_recargoNull_caeACero() {
        var f = forma(7L, "Crédito", new BigDecimal("15"), true, null, null);
        assertThat(PresupuestoComercialPdfGenerator.recargoDe(f, true)).isEqualByComparingTo("0");
        assertThat(PresupuestoComercialPdfGenerator.aplicaIvaDe(f, true)).isFalse();
    }
}
```

- [ ] **Step 2: Correr los tests y verificar que fallan**

Run: `mvn -f showroom-backend/pom.xml -q -Dtest=PresupuestoComercialPdfFormaElegidaTest test`
Expected: FAIL — "cannot find symbol: method resolverFormaElegida(...)".

- [ ] **Step 3: Implementar los helpers**

En `PresupuestoComercialPdfGenerator.java`, justo después del cierre de `agregarTotalesAgregado(...)` (tras la línea 811), agregar:

```java
    // =====================================================
    // Forma de pago elegida (modo agregado) — helpers puros.
    // Cuando el operador fija una forma, el presupuesto entero se expresa en
    // ella: precio por ítem, total y etiquetas. null = "Todas" (efectivo).
    // =====================================================

    /** Snapshot elegido por id dentro de las formas enviadas. null si id es
     *  null, la lista es null o el id no aparece (→ se trata como "Todas"). */
    static GenerarPresupuestoRequestDTO.FormaPagoSnapshot resolverFormaElegida(
            List<GenerarPresupuestoRequestDTO.FormaPagoSnapshot> formas, Long id) {
        if (id == null || formas == null) return null;
        return formas.stream().filter(f -> id.equals(f.id())).findFirst().orElse(null);
    }

    static String etiquetaColumnaPrecio(GenerarPresupuestoRequestDTO.FormaPagoSnapshot elegida) {
        return elegida == null ? "PRECIO EFECTIVO" : "PRECIO " + elegida.nombre().toUpperCase();
    }

    static String etiquetaSubtotal(GenerarPresupuestoRequestDTO.FormaPagoSnapshot elegida) {
        return elegida == null ? "Subtotal efectivo" : "Subtotal " + elegida.nombre();
    }

    static String etiquetaTotal(GenerarPresupuestoRequestDTO.FormaPagoSnapshot elegida) {
        return elegida == null ? "Total efectivo" : "Total " + elegida.nombre();
    }

    /** Recargo % del perfil que corresponde al rubro (maquinaria si esMaq).
     *  Fallback a 0 — el perfil maquinaria NO hereda del menaje. */
    static BigDecimal recargoDe(GenerarPresupuestoRequestDTO.FormaPagoSnapshot f, boolean esMaq) {
        if (esMaq) {
            return f.recargoPorcentajeMaquinaria() != null ? f.recargoPorcentajeMaquinaria() : BigDecimal.ZERO;
        }
        return f.recargoPorcentaje() != null ? f.recargoPorcentaje() : BigDecimal.ZERO;
    }

    /** aplicaIva del perfil que corresponde al rubro. Maquinaria: TRUE solo si
     *  el flag maquinaria es true. Menaje: true salvo que sea explícitamente false. */
    static boolean aplicaIvaDe(GenerarPresupuestoRequestDTO.FormaPagoSnapshot f, boolean esMaq) {
        return esMaq ? Boolean.TRUE.equals(f.aplicaIvaMaquinaria())
                     : !Boolean.FALSE.equals(f.aplicaIva());
    }
```

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `mvn -f showroom-backend/pom.xml -q -Dtest=PresupuestoComercialPdfFormaElegidaTest test`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add showroom-backend/src/main/java/ar/com/leo/showroom/presupuesto/service/PresupuestoComercialPdfGenerator.java \
        showroom-backend/src/test/java/ar/com/leo/showroom/presupuesto/service/PresupuestoComercialPdfFormaElegidaTest.java
git commit -m "feat(presupuesto): helpers de forma elegida y etiquetas para PDF agregado"
```

---

### Task 3: Aplicar la forma elegida en la tabla, el total y ocultar las cards (backend)

**Files:**
- Modify: `showroom-backend/src/main/java/ar/com/leo/showroom/presupuesto/service/PresupuestoComercialPdfGenerator.java`
  - `construir(...)` rama agregado (líneas 263-266)
  - `agregarTablaDetalle(...)` (firma 1001-1003; header 1038; bloque precio 1064-1071)
  - `agregarTotalesAgregado(...)` (785-811)
  - `agregarCardTotal(...)` (firma 1532-1533; subtotal 1554; total 1566)

**Interfaces:**
- Consumes: `resolverFormaElegida`, `etiquetaColumnaPrecio`, `etiquetaSubtotal`, `etiquetaTotal`, `recargoDe`, `aplicaIvaDe` (Task 2); `GenerarPresupuestoRequestDTO.formaPagoSeleccionadaId()` (Task 1); `PrecioPerfilCalculator.calcularPrecioFinal(...)`, `.esMaquinaria(...)`, `precioPerfilCalculator.rubrosMaquinariaNormalizados()` (existentes).
- Produces: PDF agregado que, con forma elegida, reescribe precio/total/etiquetas y omite la sección de formas.

Tarea de integración con iText (genera bytes); la lógica pura ya quedó cubierta por Task 2. Se valida con la verificación manual del Step 7.

- [ ] **Step 1: Resolver la forma elegida en `construir` y propagarla**

En `construir(...)`, rama agregado con `mostrarTotalesYFormas` (líneas 263-266), reemplazar:

```java
                if (mostrarTotalesYFormas) {
                    agregarTablaDetalle(doc, datos.items(), sinImagen);
                    agregarTotalesAgregado(doc, datos);
                    agregarFormasPago(doc, datos.formasPago(), datos.items());
                } else {
```

por:

```java
                if (mostrarTotalesYFormas) {
                    // Forma de pago elegida (null = "Todas"): cuando hay una,
                    // toda la cotización se expresa en ella y la sección
                    // comparativa de formas se omite (sus precios ya están en la
                    // tabla). Solo aplica al modo agregado.
                    GenerarPresupuestoRequestDTO.FormaPagoSnapshot formaElegida =
                            resolverFormaElegida(datos.formasPago(), datos.formaPagoSeleccionadaId());
                    agregarTablaDetalle(doc, datos.items(), sinImagen, formaElegida);
                    agregarTotalesAgregado(doc, datos, formaElegida);
                    if (formaElegida == null) {
                        agregarFormasPago(doc, datos.formasPago(), datos.items());
                    }
                } else {
```

- [ ] **Step 2: `agregarTablaDetalle` — firma + header + precio por ítem**

Cambiar la firma (líneas 1001-1003):

```java
    private void agregarTablaDetalle(Document doc,
                                     List<GenerarPresupuestoRequestDTO.Item> items,
                                     ImageData sinImagen,
                                     GenerarPresupuestoRequestDTO.FormaPagoSnapshot formaElegida) {
```

Reemplazar el header de la columna de precio (línea 1038):

```java
        tabla.addHeaderCell(celdaHeader("PRECIO EFECTIVO").setTextAlignment(TextAlignment.RIGHT));
```

por:

```java
        tabla.addHeaderCell(celdaHeader(etiquetaColumnaPrecio(formaElegida)).setTextAlignment(TextAlignment.RIGHT));
```

Reemplazar el bloque que calcula `precio` (líneas 1064-1071):

```java
            BigDecimal precio;
            if (it.precioReferencia() != null) {
                precio = it.precioReferencia();
            } else if (esMaquinaria) {
                precio = PrecioPerfilCalculator.calcularSinIva(precioConIva, porcIva);
            } else {
                precio = precioConIva;
            }
```

por:

```java
            BigDecimal precio;
            if (formaElegida != null) {
                // Precio unitario con la forma elegida, según el perfil del rubro
                // (recargo/IVA propios de menaje o maquinaria). Reusa el mismo
                // calculador que el showroom y las cards de formas.
                precio = PrecioPerfilCalculator.calcularPrecioFinal(
                        precioConIva, porcIva,
                        recargoDe(formaElegida, esMaquinaria),
                        aplicaIvaDe(formaElegida, esMaquinaria));
                if (precio == null) precio = BigDecimal.ZERO;
            } else if (it.precioReferencia() != null) {
                precio = it.precioReferencia();
            } else if (esMaquinaria) {
                precio = PrecioPerfilCalculator.calcularSinIva(precioConIva, porcIva);
            } else {
                precio = precioConIva;
            }
```

(El resto del loop —`precioConDesc`, `totalLinea`, render— ya usa `precio` y no cambia.)

- [ ] **Step 3: `agregarTotalesAgregado` — firma + total en la forma elegida**

Reemplazar el método completo (líneas 785-811) por:

```java
    private void agregarTotalesAgregado(Document doc, GenerarPresupuestoRequestDTO datos,
                                        GenerarPresupuestoRequestDTO.FormaPagoSnapshot formaElegida) {
        java.util.Set<String> rubrosMaq = precioPerfilCalculator.rubrosMaquinariaNormalizados();
        BigDecimal subtotalBruto = BigDecimal.ZERO;
        BigDecimal totalNeto = BigDecimal.ZERO;
        for (GenerarPresupuestoRequestDTO.Item it : datos.items()) {
            BigDecimal cantidad = it.cantidad() == null ? BigDecimal.ZERO : it.cantidad();
            BigDecimal precioConIva = it.precioConIva() == null ? BigDecimal.ZERO : it.precioConIva();
            BigDecimal porcIva = it.porcIva() == null ? PrecioPerfilCalculator.IVA_DEFAULT : it.porcIva();
            BigDecimal desc = it.descuentoPorcentaje() == null ? BigDecimal.ZERO : it.descuentoPorcentaje();
            boolean esMaq = PrecioPerfilCalculator.esMaquinaria(it.rubro(), rubrosMaq);
            BigDecimal precioMostrado;
            if (formaElegida != null) {
                // Precio unitario con la forma elegida (perfil del rubro). Mismo
                // criterio que la tabla de productos para que cuadren.
                precioMostrado = PrecioPerfilCalculator.calcularPrecioFinal(
                        precioConIva, porcIva,
                        recargoDe(formaElegida, esMaq), aplicaIvaDe(formaElegida, esMaq));
                if (precioMostrado == null) precioMostrado = BigDecimal.ZERO;
            } else if (it.precioReferencia() != null) {
                precioMostrado = it.precioReferencia();
            } else {
                precioMostrado = esMaq
                        ? PrecioPerfilCalculator.calcularSinIva(precioConIva, porcIva)
                        : precioConIva;
            }
            subtotalBruto = subtotalBruto.add(precioMostrado.multiply(cantidad));
            totalNeto = totalNeto.add(precioMostrado
                    .multiply(BigDecimal.ONE.subtract(desc.movePointLeft(2)))
                    .multiply(cantidad));
        }
        agregarCardTotal(doc,
                subtotalBruto.setScale(2, RoundingMode.HALF_UP),
                totalNeto.setScale(2, RoundingMode.HALF_UP),
                formaElegida);
    }
```

- [ ] **Step 4: `agregarCardTotal` — firma + etiquetas dinámicas**

Cambiar la firma (líneas 1532-1533):

```java
    private void agregarCardTotal(Document doc, BigDecimal subtotalBrutoArg,
                                  BigDecimal totalSinIvaArg,
                                  GenerarPresupuestoRequestDTO.FormaPagoSnapshot formaElegida) {
```

Reemplazar la fila de subtotal (línea 1554):

```java
            card.add(filaDesglose("Subtotal efectivo", formatPesos(subtotalBruto), false, false));
```

por:

```java
            card.add(filaDesglose(etiquetaSubtotal(formaElegida), formatPesos(subtotalBruto), false, false));
```

Reemplazar la fila de total destacado (línea 1566):

```java
        card.add(filaDesglose("Total efectivo", formatPesos(totalSinIva), true, false));
```

por:

```java
        card.add(filaDesglose(etiquetaTotal(formaElegida), formatPesos(totalSinIva), true, false));
```

- [ ] **Step 5: Compilar el backend**

Run: `mvn -f showroom-backend/pom.xml -q -DskipTests compile`
Expected: BUILD SUCCESS.

- [ ] **Step 6: Correr los tests del módulo presupuesto**

Run: `mvn -f showroom-backend/pom.xml -q -Dtest=PresupuestoComercialPdf*,GenerarPresupuestoRequestDTODeserializationTest test`
Expected: PASS (Tasks 1-2 siguen verdes).

- [ ] **Step 7: Verificación manual del PDF (humano)**

Levantar backend + frontend, en /presupuestos cargar 2-3 ítems (mezclar menaje y, si hay, una máquina). Como el frontend que envía el `formaPagoSeleccionadaId` se implementa en Task 4, probar acá con curl/Postman al endpoint `/presupuesto-comercial/preview` (body con y sin `formaPagoSeleccionadaId`), **o** ejecutar Task 4 primero y volver:
1. Sin forma (`null`) → PDF idéntico al actual: "PRECIO EFECTIVO", "Total efectivo", sección "FORMAS DE PAGO DISPONIBLES" presente.
2. Con una forma con recargo → "PRECIO {NOMBRE}", precios/total mayores, "Subtotal/Total {nombre}", sección ausente. El total debe coincidir con el `precioFinal` que esa forma mostraba en su card en el caso 1.

- [ ] **Step 8: Commit**

```bash
git add showroom-backend/src/main/java/ar/com/leo/showroom/presupuesto/service/PresupuestoComercialPdfGenerator.java
git commit -m "feat(presupuesto): PDF agregado expresa precio/total/etiquetas en la forma elegida"
```

---

### Task 4: Selector de forma de pago en la toolbar (frontend)

**Files:**
- Modify: `showroom-frontend/src/app/showroom/presupuestos-page/presupuestos-page.ts` (signal nueva tras línea 348; reset en `setModoCotizacion` línea 344-348; payload en `armarPayload` líneas 1869-1879)
- Modify: `showroom-frontend/src/app/showroom/presupuestos-page/presupuestos-page.html` (bloque "Modo de cotización" líneas 414-439)

**Interfaces:**
- Consumes: `formaPagoSeleccionadaId?: number | null` del request (Task 1); `this.formasPago` (signal `FormaPago[]`, línea 353); `this.cotizacionIndividual` (existente).
- Produces: signal `formaPagoSeleccionadaId = signal<number | null>(null)`.

Componente Angular con muchas dependencias inyectadas (sin `.spec` en esta página); se valida con `npm run build` + verificación manual.

- [ ] **Step 1: Agregar la signal y resetearla al pasar a individual**

En `presupuestos-page.ts`, tras el cierre de `setModoCotizacion(...)` (línea 348), agregar la signal (TypeScript):

```typescript
  /** Forma de pago elegida para el PDF agregado. null = "Todas" (default):
   *  precio efectivo por ítem + sección comparativa de formas. Solo aplica en
   *  modo agregado; al pasar a individual se resetea a "Todas". */
  readonly formaPagoSeleccionadaId = signal<number | null>(null);
```

Dentro de `setModoCotizacion(...)`, tras `this.cotizacionIndividual.set(value === 'individual');`, agregar:

```typescript
    // En individual el selector no aplica; volver a "Todas" deja el estado
    // coherente y evita mandar un id que el backend ignoraría.
    if (value === 'individual') this.formaPagoSeleccionadaId.set(null);
```

- [ ] **Step 2: Incluir el campo en el payload**

En `armarPayload()`, en el objeto `return { ... }` (líneas 1869-1879), tras `cotizacionIndividual: individual,` agregar:

```typescript
      // Solo en agregado: en individual el id no aplica.
      formaPagoSeleccionadaId: individual ? null : this.formaPagoSeleccionadaId(),
```

- [ ] **Step 3: Agregar el dropdown a la toolbar (solo modo agregado)**

En `presupuestos-page.html`, dentro del bloque "Modo de cotización" (`<div class="mb-3 ...">`, líneas 415-438), después del `<span>` de ayuda (cierra en la línea 437) y antes del `</div>` de la línea 438, agregar:

```html
              <!-- Forma de pago del PDF agregado. "Todas" (default) = precio
                   efectivo por ítem + sección comparativa de formas. Al elegir
                   una, todo el presupuesto se expresa en ella. No aplica en
                   modo individual (cada ítem lista sus formas). -->
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

(`[showClear]="true"` + `placeholder="Todas"`: limpiar el select vuelve a `null` = "Todas". `formasPago()` son entidades `FormaPago` con `id`/`nombre`.)

- [ ] **Step 4: Verificar el build del frontend**

Run: `cd showroom-frontend && npm run build`
Expected: build OK, sin errores de plantilla ni de tipo.

- [ ] **Step 5: Verificación manual end-to-end (humano)**

1. /presupuestos con ítems, selector en **Agregado**: el dropdown "Forma de pago" aparece con "Todas" por default.
2. Previsualizar con "Todas" → PDF como hoy.
3. Elegir una forma (ej. Transferencia) → previsualizar → columna "PRECIO TRANSFERENCIA", "Total Transferencia", sin sección de cards; montos coinciden con la card de esa forma en el caso "Todas".
4. Cambiar a **Individual** → el dropdown desaparece y el PDF individual no se ve afectado.
5. Guardar con una forma elegida y **regenerar desde el historial** → sale con la misma forma (valida la persistencia de Task 1 de punta a punta). Guardar otro con "Todas" → regenera en "Todas".
6. Confirmar que el foco del scan no queda atrapado por el nuevo control (la pistola QR sigue escaneando tras usar el dropdown).

- [ ] **Step 6: Commit**

```bash
git add showroom-frontend/src/app/showroom/presupuestos-page/presupuestos-page.ts \
        showroom-frontend/src/app/showroom/presupuestos-page/presupuestos-page.html
git commit -m "feat(presupuesto): selector de forma de pago para el PDF agregado en la toolbar"
```

---

## Notas de verificación final (tras todas las tareas)

- Backend completo: `mvn -f showroom-backend/pom.xml test` (toda la suite en verde).
- Frontend: `cd showroom-frontend && npm run build` (typecheck OK).
- Regresión "Todas": un presupuesto sin forma elegida produce el PDF histórico (columna/total "efectivo", cards presentes).
- Mixto menaje + maquinaria con forma elegida: cada línea respeta su perfil (recargo/IVA) — comparar contra la card de esa forma en modo "Todas".
- Presupuesto viejo (sin `precioReferencia`, columna nueva en NULL) regenera sin error y en modo "Todas".
