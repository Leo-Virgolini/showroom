# Formas de pago con 2 perfiles (Normal / Maquinaria) — Diseño

**Fecha:** 2026-06-04
**Estado:** Diseño aprobado — implementación directa por capas.

## Problema

Hoy una forma de pago tiene un único `recargoPorcentaje` y un único `aplicaIva`.
El rubro del producto decide la base (los rubros de la lista "cotizan sin IVA"
usan el PVP sin IVA). El operador necesita que **cada forma tenga condiciones
distintas según el rubro**: recargo **y** IVA propios para productos normales vs
maquinaria (ver tabla del usuario: dos filas por forma, cada una con Recargo + IVA).

## Modelo: 2 perfiles por forma

Cada `forma_pago` guarda condiciones por perfil:

| Perfil | Recargo | Aplica IVA |
|---|---|---|
| **Normal** | `recargoPorcentaje` (existente) | `aplicaIva` (existente) |
| **Maquinaria** | `recargoPorcentajeMaquinaria` (nuevo, nullable) | `aplicaIvaMaquinaria` (nuevo, nullable) |

- El **rubro del producto** decide el perfil. La lista que hoy se llama "Rubros
  que cotizan sin IVA" pasa a ser, conceptualmente, **"Rubros de maquinaria"**
  (define el grupo; el IVA ya no es fijo, es parte del perfil). La clave de
  config interna `precios.rubros-sin-iva` se mantiene; solo cambia la etiqueta UI.
- **Fallback** (migración / sin configurar): `recargoPorcentajeMaquinaria` null →
  usa `recargoPorcentaje`; `aplicaIvaMaquinaria` null → `false` (sin IVA, como hoy).

## Cálculo unificado (display)

`precioPorForma(conIva, porcIva, { recargo, aplicaIva })` (sin cambios). El precio
SIEMPRE parte del PVP con IVA; el `aplicaIva` del **perfil** decide si lleva IVA:
- perfil con IVA → `conIva × factor`
- perfil sin IVA → `(conIva/(1+iva)) × factor`

`factor`: `r>0 → 1/(1−r/100)`; `r<0 → 1−|r|/100`; `0 → 1`.

Esto **reemplaza** el mecanismo de "base por rubro" (que forzaba sin-IVA para
maquinaria). Un helper resuelve el perfil:

```
perfilDe(rubro, forma) = esMaquinaria(rubro)
  ? { recargo: forma.recargoPorcentajeMaquinaria ?? forma.recargoPorcentaje,
      aplicaIva: forma.aplicaIvaMaquinaria ?? false }
  : { recargo: forma.recargoPorcentaje, aplicaIva: forma.aplicaIva ?? true }
```

`esMaquinaria(rubro)` = el rubro normalizado está en la lista de rubros de
maquinaria (la actual `rubrosSinIva`).

Aplica en: scan, visor, resultados de búsqueda, y carrito.

## Carrito mixto

El total y el desglose se calculan **ítem por ítem**: cada producto usa el perfil
(Normal/Maquinaria) de su rubro para la **forma elegida** (selector único). El
"Descuento por pago" suma el descuento de cada ítem según su perfil; el "IVA"
suma solo el de los ítems cuyo perfil lleva IVA.

## Pedido a DUX

Por ítem sube el **precio CON IVA** con el **recargo/descuento del perfil de su
rubro** aplicado, **siempre con IVA** (DUX factura con IVA; se ignora el
`aplicaIva` del perfil para DUX):

```
precioDux(item) = conIva × factor(recargo del perfil del rubro del item)
```

El backend del armado del pedido resuelve, por ítem, el perfil según el rubro
(consultando la lista de rubros de maquinaria) y lo pasa al cálculo.

## Configuración (UI)

- Dialog de forma de pago: dos bloques **Normal** y **Maquinaria**, cada uno con
  su recargo (%) y su check "Aplica IVA".
- Tabla de formas: dos sub-filas por forma (Normal / Maquinaria) con Recargo + IVA,
  como la tabla de referencia del usuario.
- La tarjeta "Rubros que cotizan sin IVA" se renombra a **"Rubros de maquinaria"**
  (mismo multiselect, misma clave de config).

## Alcance / archivos

- **Backend:** `FormaPago` (2 columnas), `FormaPagoDTO`, `FormaPagoService`
  (crear/actualizar/toDTO/validar), `ShowroomService` (helper `esRubroMaquinaria`
  + `aplicarRecargoSinIva` ya existe; `calcularPrecioFinal`/`calcularPrecioParaDux`
  reciben el perfil por rubro; armado del pedido + `construirPayloadDux` resuelven
  el perfil por ítem). Normalización de rubro en Java.
- **Frontend:** `models.ts` (FormaPago + 2 campos), `precio-referencia.util.ts`
  (sin cambio de fórmula; quizá helper de perfil), `showroom-page.ts/html`
  (precioReferenciaPorForma usa perfil; carrito per-ítem), `visor-page.ts/html`,
  `configuracion-page.ts/html` (dialog 2 bloques + tabla 2 filas + renombre).

## Fallback / compatibilidad

Formas existentes: sin campos de maquinaria → perfil Maquinaria = recargo normal,
sin IVA (preserva el comportamiento actual). El operador luego configura los
perfiles de maquinaria por forma.
