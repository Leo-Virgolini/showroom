# Selección de forma de pago en el PDF de presupuesto agregado

Fecha: 2026-06-26

## Objetivo

Permitir elegir una forma de pago al generar el PDF de un **presupuesto agregado**.
Hoy el PDF agregado siempre muestra los precios "en efectivo" (la forma destacada
`precioReferencia`) por ítem y un bloque comparativo "FORMAS DE PAGO DISPONIBLES"
al final. Se quiere poder fijar una forma concreta para que toda la cotización
(precio por ítem + total) se exprese en esa forma.

## Comportamiento esperado

En la toolbar de la pantalla de presupuestos se agrega un selector **"Forma de
pago"**, visible y aplicable **solo en modo Agregado**:

- Opción **"Todas"** preseleccionada por default → **comportamiento idéntico al
  actual**:
  - Columna `PRECIO EFECTIVO` por ítem (precio `precioReferencia` por rubro:
    menaje c/IVA, maquinaria s/IVA).
  - Card de totales con `Subtotal efectivo` / `Total efectivo`.
  - Sección "FORMAS DE PAGO DISPONIBLES" con las cards de todas las formas.

- Una **forma elegida** (ej. Transferencia):
  - Cada ítem muestra su **precio unitario según esa forma** (con su recargo/IVA y
    el perfil del rubro).
  - El **total** se calcula con esa forma.
  - La columna pasa a `PRECIO {NOMBRE}` en mayúsculas (ej. `PRECIO TRANSFERENCIA`).
  - El total pasa a `Subtotal {nombre}` / `Total {nombre}` (ej. `Total transferencia`).
  - La sección "FORMAS DE PAGO DISPONIBLES" **se oculta** (los precios de la tabla
    ya son de esa forma, las cards comparativas sobran).

En modo **Individual** el selector no aplica (cada ítem ya lista sus propias
formas); el dropdown se oculta o deshabilita.

La forma elegida **se persiste** con el presupuesto, de modo que al regenerar el
PDF desde el historial se respeta.

## Arquitectura

El backend **ya sabe** calcular el precio de una línea/ítem según una forma de
pago con su perfil de rubro: `precioFormaPerfil(forma, esMaquinaria, item)` y
`PrecioPerfilCalculator.calcularPrecioFinal(precioConIva, porcIva, recargo, aplicaIva)`
en `PresupuestoComercialService`. No se reimplementa lógica de cálculo: se reusa.

El frontend ya envía los snapshots de **todas** las formas (`formasPago`) con su
`recargoPorcentaje`, `recargoPorcentajeMaquinaria`, `aplicaIva`, `aplicaIvaMaquinaria`
y `nombre`. Para fijar una forma basta con enviar su **id**; el backend la resuelve
desde esa lista.

### Frontend — `presupuestos-page.ts` / `.html`

- Nueva signal `formaPagoSeleccionadaId = signal<number | null>(null)` (`null` = "Todas").
- Dropdown PrimeNG en la toolbar (junto al toggle Agregado/Individual), con opción
  "Todas" (valor `null`) al tope, seguida de cada forma configurada. Solo se muestra
  en modo Agregado.
- En `generarPayload()` se agrega `formaPagoSeleccionadaId` al request. No se calculan
  precios nuevos en el front.
- Seguir el lineamiento del proyecto: usar `class`, no `styleClass`; mantener el foco
  del scan al cerrar cualquier control nuevo (el dropdown vive en la toolbar, no abre
  overlay modal, pero se verifica que no robe el foco de la pistola).

### Backend

- **DTO** `GenerarPresupuestoRequestDTO`: nuevo campo nullable `Long formaPagoSeleccionadaId`.
  (Jackson 3: campo opcional → wrapper `Long`, nunca primitivo.)
- **Entity** `PresupuestoComercial`: nueva columna nullable `formaPagoSeleccionadaId`
  (`Long`). Se setea al generar/guardar y se rehidrata al regenerar.
  - `rehidratarDatos(...)` incluye el id en el DTO reconstruido.
  - `forzarModoIndividual(...)`: la forma elegida no aplica a individual (se ignora).
  - `forzarModoAgregado(...)`: un presupuesto originalmente individual no trae forma
    elegida → queda `null` ("Todas").
- **`PresupuestoComercialPdfGenerator`** (solo modo agregado): resuelve el snapshot
  elegido por `id` dentro de `datos.formasPago()`. Si hay forma:
  - `agregarTablaDetalle()`: header `"PRECIO " + nombre.toUpperCase()`; precio unitario
    por ítem vía `calcularPrecioFinal(precioConIva, porcIva, recargo, aplicaIva)` con el
    perfil del rubro de la línea. El total de línea aplica el descuento por ítem encima.
  - `agregarTotalesAgregado()` / `agregarCardTotal()`: subtotal y total con
    `precioFormaPerfil(...)`; etiquetas `"Subtotal {nombre}"` y `"Total {nombre}"`.
  - `agregarFormasPago()`: no se renderiza.
  - Revisar y ajustar cualquier texto hardcodeado "efectivo" del modo agregado para que
    refleje la forma elegida (header de columna, labels de la card de total, y la nota de
    pie si corresponde).
  - Si `formaPagoSeleccionadaId == null` → todo queda exactamente como hoy.

## Casos borde

- Forma elegida que ya no existe / no está en los snapshots enviados → tratar como
  "Todas" (no romper la generación).
- Ítem sin precio (`precio <= 0`) → sigue mostrando "Consultar" como hoy, independiente
  de la forma.
- Presupuesto viejo sin `precioReferencia` → el caso "Todas" mantiene el fallback actual
  por rubro; el caso con forma elegida usa `precioConIva` como base del cálculo.
- Moneda extranjera en la forma: el comportamiento actual del PDF agregado trabaja en
  pesos; mantener ese supuesto (las formas en moneda extranjera son un caso del modo
  individual / cards, que aquí se ocultan).

## Out of scope (YAGNI)

- No se cambia el modo Individual.
- No se agregan nuevas formas de pago ni se toca su configuración.
- No se modifica la lista KT GASTRO ni precios en DUX.
- No se toca el visor en vivo ni el flujo de pedido.

## Verificación

- "Todas" → el PDF es byte-equivalente al actual (sin regresiones).
- Forma elegida → columna, total y labels muestran el nombre de la forma; los montos
  coinciden con los que hoy aparecen en la card de esa forma; la sección de cards no
  aparece.
- Persistencia: generar con forma elegida, regenerar desde historial → mismo resultado.
- Mixto menaje + maquinaria con una forma elegida → cada línea respeta su perfil
  (recargo/IVA) correcto.
