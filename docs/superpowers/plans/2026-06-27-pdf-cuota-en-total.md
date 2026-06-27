# PDF: monto de cada cuota en la card de total — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** En el PDF de presupuesto agregado, cuando la forma elegida tiene cuotas (N>1), mostrar "N cuotas de $X" debajo del total.

**Architecture:** Un agregado en `agregarCardTotal` del generador de PDF: tras la fila del total, si la forma elegida tiene `cantidadCuotas > 1`, una línea pequeña con `cuota = total / cantidadCuotas`. Reusa el formato existente.

**Tech Stack:** Spring Boot 4 + Java 25, iText. Test: `mvn -f showroom-backend/pom.xml test`.

## Global Constraints

- Solo cuando `formaElegida != null && cantidadCuotas() != null && cantidadCuotas() > 1`. Forma de 1 cuota o "Todas" ⇒ card igual que hoy.
- Formato "N cuotas de $X", `cuota = total / cantidadCuotas` (HALF_UP, 2 decimales) — mismo patrón que las cards de formas de pago.
- No cambiar el cálculo del total ni el resto de la card.

---

### Task 1: Línea "N cuotas de $X" en la card de total

**Files:**
- Modify: `showroom-backend/src/main/java/ar/com/leo/showroom/presupuesto/service/PresupuestoComercialPdfGenerator.java` (`agregarCardTotal` ~1615-1616)

**Interfaces:**
- Consumes: `GenerarPresupuestoRequestDTO.FormaPagoSnapshot.cantidadCuotas()` (existente), `formatPesos`, `GRIS_MEDIO` (existentes en el archivo).

- [ ] **Step 1: Agregar la línea de cuota tras el total**

En `agregarCardTotal`, entre `card.add(filaDesglose(etiquetaTotal(formaElegida), ...));` (~1615) y `doc.add(card);` (~1616), insertar:

```java
        card.add(filaDesglose(etiquetaTotal(formaElegida), formatPesos(totalSinIva), true, false));
        // Forma en cuotas: mostrar el valor de cada cuota debajo del total para
        // que no se confunda el total con la cuota. Mismo formato "N cuotas de
        // $X" que las cards de formas de pago (cuota = total / N).
        if (formaElegida != null && formaElegida.cantidadCuotas() != null
                && formaElegida.cantidadCuotas() > 1) {
            BigDecimal cuota = totalSinIva.divide(
                    BigDecimal.valueOf(formaElegida.cantidadCuotas()), 2, RoundingMode.HALF_UP);
            card.add(new Paragraph(formaElegida.cantidadCuotas() + " cuotas de " + formatPesos(cuota))
                    .setFontSize(9)
                    .setFontColor(GRIS_MEDIO)
                    .setTextAlignment(TextAlignment.RIGHT)
                    .setMargin(0)
                    .setMarginTop(3));
        }
        doc.add(card);
```

(Es un reemplazo del par de líneas `card.add(filaDesglose(etiquetaTotal...))` + `doc.add(card);` por el bloque de arriba. `Paragraph`, `TextAlignment`, `BigDecimal`, `RoundingMode`, `formatPesos`, `GRIS_MEDIO` ya están en el archivo.)

- [ ] **Step 2: Compilar + suite**

Run: `mvn -f showroom-backend/pom.xml test 2>&1 | grep -E "Tests run: [0-9]+, Failures.*Skipped: [0-9]+$|BUILD"`
Expected: `BUILD SUCCESS`, 0 failures.

- [ ] **Step 3: Verificación manual (humano)**

Generar un PDF de presupuesto agregado con una forma elegida de N>1 cuotas → la card de total muestra "Total {nombre}" y debajo "N cuotas de $X" (X = total / N). Con forma de 1 cuota o "Todas" → la card no muestra la línea.

- [ ] **Step 4: Commit**

```bash
git add showroom-backend/src/main/java/ar/com/leo/showroom/presupuesto/service/PresupuestoComercialPdfGenerator.java
git commit -m "feat(presupuesto): mostrar el monto de cada cuota en la card de total del PDF"
```

---

## Notas de verificación final

- Backend: `mvn -f showroom-backend/pom.xml test` en verde.
- Forma en cuotas (N>1): card de total con "N cuotas de $X". Otra forma / "Todas": sin la línea.
