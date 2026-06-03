# Precios de referencia en scan + visor (vía formas de pago)

**Fecha:** 2026-06-03
**Estado:** Diseño aprobado — pendiente de plan de implementación

## Problema / objetivo

Hoy el panel de scan (showroom) y el visor del cliente muestran **un solo precio**:
el `pvpKtGastroSinIva` (PVP gastro de la lista KT GASTRO, con IVA descontado).

Se quiere mostrar **varios precios de referencia** simultáneamente para que el
operador y el cliente vean las opciones de pago de un vistazo. Conceptualmente:

| Precio | Fórmula sobre PVP gastro CON IVA | Ejemplo % |
|---|---|---|
| Precio Efectivo | `conIva − 13%` | el más barato |
| Precio Transferencia | `conIva` (sin descuento) | precio lista |
| Precio Transferencia S/F | `conIva − 9%` | intermedio |

En vez de hardcodear estos precios, se **reutiliza el modelo de formas de pago
existente** (`forma_pago`): cada precio de referencia es una forma de pago, y un
flag nuevo decide cuáles se muestran como referencia. Esto da **una sola fuente
de verdad**: el visor muestra exactamente lo que después calcula el carrito.

## Decisiones tomadas (con el usuario)

1. **Alcance:** scan + visor + carrito (precio unitario por ítem). Pedido a DUX,
   presupuestos y cotizaciones **no se tocan** (presupuestos: pendiente, lo
   define el usuario más adelante).
2. **Modelo:** los precios de referencia son **formas de pago** con un flag nuevo
   `precioReferencia` (boolean). NO se crean campos de % fijos sueltos.
3. **Descuentos:** se representan con `recargoPorcentaje` **negativo** (ej. Efectivo
   `−13`, Transferencia `0`, Transf. S/F `−9`).
4. **Precio a DUX:** **siempre el precio lista** (`pvpKtGastroConIva`), sin importar
   la forma. Los 3 precios son solo para mostrar/negociar. El backend ya logra
   esto sin cambios (ver más abajo).
5. **Umbral de escala (display individual):** se evalúa contra el precio de la
   **primera** forma de referencia (menor `orden`).
6. **Carrito:** cambia solo el **precio unitario por ítem** (pasa a la primera
   forma de referencia). El selector de formas de pago y el **total siguen como
   hoy**.
7. **IVA por cuotas:** se deja **como está** (IVA sobre precio + recargo financiero,
   tratamiento estándar de financiación propia en AR). Fuera de alcance.
8. **Nombre del flag:** `precioReferencia`.

## Por qué el pedido a DUX no cambia

Tanto el frontend (`totalParaForma`: `recargo > 0 ? … : 1`) como el backend
(`ShowroomService.calcularPrecioFinal` / armado del pedido: `recargoPorc.signum() > 0`)
**solo aplican recargos positivos**. Un recargo ≤ 0 se ignora y el precio queda
igual al base. Por lo tanto:

- El **pedido a DUX** seguirá subiendo `pvpKtGastroConIva` para las formas con
  descuento (Efectivo/Transf. S/F), **sin modificar el backend de pedidos**.
- Solo hay que extender el cálculo de **display** (frontend) para que un recargo
  negativo se muestre como descuento.

⚠️ **Nota de coherencia (consciente):** el total que ve el cliente en el carrito
(con descuento de la forma) no coincidirá con lo facturado en DUX (siempre precio
lista). Es una decisión deliberada del negocio.

## Fórmula de display por forma de pago

Dado un precio `conIva`, su `porcIva` y una forma con `recargoPorcentaje = r` y
`aplicaIva`:

```
baseSinIva = conIva / (1 + porcIva/100)

if r > 0:   ajustadoSinIva = baseSinIva / (1 - r/100)        # encarece (financiación)
if r == 0:  ajustadoSinIva = baseSinIva
if r < 0:   ajustadoSinIva = baseSinIva * (1 - |r|/100)      # descuenta (NUEVO)

precioForma = aplicaIva ? ajustadoSinIva * (1 + porcIva/100) : ajustadoSinIva
```

Verificación:
- Transferencia (`r=0`, `aplicaIva=true`): `conIva` ✓
- Efectivo (`r=−13`, `aplicaIva=true`): `conIva × 0,87` ✓
- Transf. S/F (`r=−9`, `aplicaIva=true`): `conIva × 0,91` ✓

El descuento de escala (volumen) se aplica **encima** del precio de cada forma:
`precioForma × (1 − escala%/100)`.

## Componentes a tocar

### Backend

- **`config/entity/FormaPago.java`**: nueva columna `precio_referencia`
  (`boolean`, not null, default `false`). Como `ddl-auto=update`, la columna se
  agrega al arrancar; las filas existentes deben quedar en `false`
  (definir con default DDL / tratar `null` como `false` en lectura, igual que
  `aplicaIva`).
- **`dto/FormaPagoDTO`**: agregar `precioReferencia`.
- **`FormaPagoService`**: `crear`/`actualizar`/`toDTO` deben manejar el campo
  (default `false` si null). Agregar al `validar` un sanity check de **límite
  inferior** del recargo (ej. no menor a `−99%`), ya que ahora se aceptan
  negativos.
- **Endpoints** (`ShowroomController`): `GET /config/formas-pago`,
  `GET /formas-pago/activas` y `PUT /config/formas-pago/{id}` ya existen; solo
  propagan el campo nuevo vía DTO.
- **Pedido / DUX:** sin cambios.

### Frontend

- **`models.ts`**: interface `FormaPago` → agregar `precioReferencia: boolean`.
- **Helper de cálculo compartido** (donde sea más limpio, ej. un util o método en
  `showroom-page` reutilizado): `precioPorForma(conIva, porcIva, forma)` con la
  fórmula de arriba. Refactor de `totalParaForma` para soportar `r < 0` como
  descuento.
- **`showroom-page.ts`**:
  - `computed formasReferencia` = formas activas con `precioReferencia=true`,
    ordenadas por `orden` (asc).
  - `formaReferenciaPrimaria` = primera de la lista.
  - Métodos para calcular el precio de referencia de un `ScanResult` / `CarritoItem`
    por cada forma, y con descuento de escala.
  - Umbral de escala individual evaluado contra el precio de la forma primaria.
  - Precio unitario por ítem del carrito = precio de la forma primaria.
- **`showroom-page.html`**:
  - Reemplazar el bloque "PRECIO PRINCIPAL" (hoy `pvpKtGastroSinIva`) por: una
    línea por forma de referencia — la **primera destacada grande** (naranja KT
    `#FF861C`), el resto en chico debajo con su nombre como etiqueta.
  - Tiles "Comprá más y ahorrás": cada tile muestra **N líneas etiquetadas** (una
    por forma de referencia) con el descuento de escala aplicado.
  - Grilla del carrito: precio unitario `c/u` pasa a la forma primaria. El
    **subtotal de línea** (`subtotal(it)`) debe usar el **mismo** precio que el
    unitario para que `precio × cantidad` cuadre (hoy ambos usan
    `pvpKtGastroSinIva`). El `SUBTOTAL` global y el `TOTAL A COBRAR` siguen
    dependiendo del selector de forma de pago como hoy.
- **`visor-page.ts` / `visor-page.html`**: mismos cambios de display que el panel
  de scan (bloque principal + tiles de volumen).
- **`configuracion-page`**: en la sección de formas de pago, agregar un check
  **"Mostrar como precio de referencia"** (`precioReferencia`) por forma. El
  `orden` existente define cuál es la primera.

## Diseño visual

- Respetar la paleta KT Gastro: naranja `#FF861C`, marrón `#3B1E09`, y el esquema
  de colores alternados que ya usan los tiles de escala (`escalaColorScheme`).
- Evitar `backdrop-blur` (regla del proyecto).
- PrimeNG: usar `class`, no `styleClass`.
- En implementación se aplicarán los principios del skill `frontend-design` para
  el pulido, manteniendo coherencia con el resto del showroom.

## Casos borde

- **Sin formas de referencia marcadas:** fallback al comportamiento previo o un
  estado vacío razonable (a definir en el plan; lo más simple: si no hay ninguna
  marcada, mostrar el precio lista `conIva` como única línea).
- **Rubros excluidos de descuento por escala (MAQUINAS INDUSTRIALES):** siguen sin
  mostrar tiles de volumen; sí muestran los precios de referencia base.
- **Productos genéricos** (SKU comodín): tienen `conIva` + `porcIva`, los precios
  de referencia se calculan igual.
- **Filas `forma_pago` viejas:** `precioReferencia` null → tratar como `false`.

## Fuera de alcance

- Presupuestos, cotizaciones y sus PDFs (el usuario lo define luego). Nota: si se
  marca Efectivo/Transf. S/F como `activo`, podrían aparecer en esos flujos con su
  descuento — revisar al abordar presupuestos.
- Cambio del tratamiento del IVA por cuotas.
- Cambio del precio que sube a DUX.
