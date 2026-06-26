# SKU como link + ícono de maquinaria en las tablas de historiales

Fecha: 2026-06-26

## Objetivo

En las tablas de detalle de ítems de **pedidos**, **presupuestos (historial)** y
**atenciones (historial)**, hacer dos cosas:

1. Que el **SKU** de cada ítem sea un link que abre la pantalla de productos
   filtrada por ese SKU (en una pestaña nueva).
2. Mostrar un **ícono de maquinaria** (sin texto) en los ítems cuyo rubro es
   `MAQUINAS INDUSTRIALES`, igual que ya hace la tabla de productos pero
   reducido a un ícono con tooltip.

## Tablas afectadas (celda del ítem)

- Pedidos: [pedidos-page.html](../../../showroom-frontend/src/app/showroom/pedidos-page/pedidos-page.html) — SKU en la línea ~518, descripción ~519.
- Atenciones: [historial-page.html](../../../showroom-frontend/src/app/showroom/historial-page/historial-page.html) — SKU ~409, descripción ~410.
- Presupuestos: [presupuestos-historial-page.html](../../../showroom-frontend/src/app/showroom/presupuestos-historial-page/presupuestos-historial-page.html) — SKU ~346, descripción ~347.

(Las tres tablas son `p-table` anidadas dentro del row-expansion del registro;
las filas internas son ítems con `it.sku`.)

## Feature 1 — SKU como link

Reemplazar el texto plano del SKU por un ancla que navega a `/productos` con el
SKU como filtro `q`, abriendo en **pestaña nueva**:

```html
<a [routerLink]="['/productos']" [queryParams]="{ q: it.sku }"
   target="_blank" rel="noopener"
   class="font-mono text-sm text-primary hover:underline"
   pTooltip="Ver en el catálogo" tooltipPosition="top">
  {{ it.sku }}
</a>
```

- La pantalla `/productos` ya lee el query param `q` y lo aplica a su búsqueda
  (busca por SKU/descripción/código). No requiere cambios en productos-page.
- `target="_blank" rel="noopener"`: abre el catálogo sin perder el historial
  donde está el operador.
- Aplica a las **3** tablas (las 3 tienen `it.sku`).

## Feature 2 — Ícono de maquinaria (sin texto)

Antes de la descripción del producto, mostrar un ícono cuando el rubro del ítem
es de maquinaria, usando el **mismo criterio que productos**:
`rubroExcluyeDescuentos(rubro)` de
[models.ts](../../../showroom-frontend/src/app/showroom/models.ts) (lista
`RUBROS_SIN_DESCUENTO_ESCALA = {'MAQUINAS INDUSTRIALES'}`, normalizando el rubro).

```html
<td>
  @if (esRubroMaquinaria(it.rubro)) {
    <i class="pi pi-wrench text-amber-600 dark:text-amber-400 mr-1 text-[0.7rem]"
       pTooltip="Maquinaria · MAQUINAS INDUSTRIALES" tooltipPosition="top"></i>
  }
  {{ it.descripcion ?? '—' }}
</td>
```

- Mismo ícono (`pi pi-wrench`) y misma paleta ámbar que el badge de productos,
  pero **solo el ícono** (sin el texto del rubro) + tooltip que aclara.
- Cada componente expone un helper trivial que delega en la función pura, p. ej.
  `protected readonly esRubroMaquinaria = rubroExcluyeDescuentos;` (o un método
  `esRubroMaquinaria(rubro)` que la llame), para no duplicar la lógica.

### Disponibilidad del rubro por tabla

- **Atenciones**: `SesionScanItem.rubro` ya existe → solo HTML + helper.
- **Presupuestos**: el ítem del detalle ya trae `rubro` → solo HTML + helper.
- **Pedidos**: el ítem **no** persiste el rubro → requiere backend (abajo).

## Backend — persistir el rubro del ítem de pedido

El rubro del ítem ya está disponible al crear el pedido (`it.rubro()` en
`PedidoService.crearPedido`), solo no se guarda. Cambios:

1. **Entity** `PedidoShowroomItem`: nueva columna `rubro` (`String`, nullable).
2. **Creación**: en el `PedidoShowroomItem.builder()` de `crearPedido`, setear
   `.rubro(it.rubro())` — el rubro **del producto** que mandó el front (no el
   `rubroItem` con fallback al rubro del cliente, que es para el cálculo de
   perfil; acá queremos el rubro real del ítem para el ícono).
3. **DTO** `PedidoItemDTO`: nuevo campo `String rubro`.
4. **Lectura**: en el mapeo entity→DTO (`PedidoService` ~línea 294), pasar
   `it.getRubro()`.
5. **Frontend**: agregar `rubro?: string | null` al modelo del ítem de pedido en
   `models.ts`.

Pedidos creados antes del cambio quedan con `rubro = NULL` → sin ícono. La
columna nullable se agrega con `ddl-auto`, sin migración manual.

## Out of scope (YAGNI)

- No se toca la pantalla de productos ni su filtro.
- No se cambian otras columnas ni el resto del flujo de pedidos/presupuestos.
- No se retro-completa el rubro de pedidos históricos.
- El ícono no se agrega en tablas que no listan ítems con SKU.

## Verificación

- SKU-link: clic en un SKU de cada tabla abre `/productos?q=SKU` en pestaña nueva
  y queda filtrado a ese producto.
- Ícono: un ítem de rubro `MAQUINAS INDUSTRIALES` muestra el `pi-wrench` antes de
  la descripción en las 3 tablas; un ítem de otro rubro no.
- Pedidos: crear un pedido nuevo con un ítem de maquinaria → al verlo en la tabla
  de pedidos aparece el ícono; un pedido viejo (rubro NULL) no rompe y no muestra
  ícono.
- Backend en verde (`mvn -f showroom-backend/pom.xml test`) y frontend compila
  (`cd showroom-frontend && npm run build`).

## Nota de implementación

Esta feature es independiente del trabajo en curso de "forma de pago en el PDF
de presupuesto agregado" (rama `feature/forma-pago-pdf-presupuesto`). Va en su
propia rama.
