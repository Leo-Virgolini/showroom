# PDF: monto de cada cuota en la card de total

Fecha: 2026-06-27

## Objetivo

En el PDF de presupuesto agregado, cuando la forma de pago elegida tiene cuotas
(`cantidadCuotas > 1`), mostrar en la card de total **cuánto es cada cuota**, para
que el cliente no confunda el total con el valor de la cuota.

## Contexto actual

- `agregarCardTotal(doc, subtotal, total, formaElegida)` arma la card con
  "Subtotal {nombre}", "Descuento (X%)" y "Total {nombre}".
- La forma elegida (`FormaPagoSnapshot`) ya trae `cantidadCuotas`.
- El PDF ya usa el formato **"N cuotas de $X"** en las cards de formas de pago
  (`cuota = precioFinal / cantidadCuotas`, redondeo HALF_UP a 2 decimales).

## Diseño

En `agregarCardTotal`, después de la fila del total
(`filaDesglose(etiquetaTotal(formaElegida), ...)`), si
`formaElegida != null && formaElegida.cantidadCuotas() != null &&
formaElegida.cantidadCuotas() > 1`:

- Calcular `cuota = totalSinIva / cantidadCuotas` (HALF_UP, 2 decimales).
- Agregar una línea pequeña alineada a la derecha con el texto
  **"{N} cuotas de {formatPesos(cuota)}"** (fuente chica, gris/marrón suave),
  debajo del total.

Sin forma elegida, o con forma de 1 cuota (Efectivo, Transferencia, etc.) → la
card queda **igual que hoy** (sin la línea).

## Out of scope (YAGNI)

- No se cambia el cálculo del total ni de las cuotas (reusa el patrón existente).
- No se tocan las cards de formas de pago (que ya muestran su propia cuota).
- No se cambia nada del modo "Todas" ni de cotización individual.

## Verificación

- Un presupuesto con forma elegida de N>1 cuotas → la card de total muestra
  "Total {nombre}" y debajo "N cuotas de $X" (X = total / N).
- Forma de 1 cuota o "Todas" → card sin la línea, como hoy.
- Backend en verde (`mvn -f showroom-backend/pom.xml test`).
