# Diseño — Clientes por CUIT, filtros de catálogo, IVA a DUX y ajustes de carrito

Fecha: 2026-06-11
Estado: propuesto (pendiente de aprobación)

Lote de 6 mejoras pedidas. Decisiones de arquitectura ya acordadas con el usuario
(ver "Decisiones" al final). Cada sección está escalada a su complejidad.

---

## 1. IVA a DUX según el perfil de la forma de pago

**Problema.** Al generar un pedido, a DUX se sube **siempre con IVA**
(`construirPayloadDux` usa `calcularPrecioParaDux`, que ignora a propósito el
`aplicaIva` del perfil). Resultado: en formas sin IVA para maquinaria (ej.
Efectivo), DUX factura de más y el operador "absorbe" la diferencia. El usuario
quiere que a DUX vaya **exactamente el precio que paga el cliente según el
perfil** (Efectivo: menaje c/IVA, maquinaria s/IVA).

**Cambio.** En `ShowroomService.construirPayloadDux`
([:1288-1290](../../../showroom-backend/src/main/java/ar/com/leo/showroom/showroom/service/ShowroomService.java))
reemplazar:

```java
BigDecimal precioDux = formaPago != null
        ? calcularPrecioParaDux(precioBaseConIva, porcIva, recargoPerfil(formaPago, esMaq))
        : precioBaseConIva;
```

por la misma fórmula que usa el precio local (`crearPedido`, [:909](../../../showroom-backend/src/main/java/ar/com/leo/showroom/showroom/service/ShowroomService.java)):

```java
boolean aplicaIvaItem = aplicaIvaPerfil(formaPago, esMaq);
BigDecimal precioDux = formaPago != null
        ? calcularPrecioFinal(precioBaseConIva, porcIva, recargoPerfil(formaPago, esMaq), aplicaIvaItem)
        : precioBaseConIva;
```

Así `precioDux` == `precioFinal` (lo que ya se persiste y se muestra en el
preview). DUX factura lo que paga el cliente; desaparece el "IVA absorbido" en
líneas sin IVA.

**Impacto.** Cambia lo que DUX factura en líneas sin IVA (factura menos). Es el
comportamiento explícitamente pedido. Se actualiza la memoria
`proyecto_precios_referencia.md` (que documentaba lo contrario) y el comentario
de `calcularPrecioParaDux` (queda sin uso → se elimina si no lo usa nadie más).

**Verificación.** Test unitario con forma Efectivo + un ítem menaje y uno
maquinaria: el `precio` del payload DUX del menaje lleva IVA, el de maquinaria
no. Revisar que ningún otro caller use `calcularPrecioParaDux`.

---

## 2. Razón social editable (quitar "PRESUPUESTO"/"SHOWROOM" fijos)

**Problema.** `apellido_razon_social` va a DUX con un placeholder fijo:
`'PRESUPUESTO'` en el diálogo de pedido desde presupuesto
([crear-pedido-dialog.ts:44](../../../showroom-frontend/src/app/showroom/crear-pedido-dialog/crear-pedido-dialog.ts))
y `'SHOWROOM'`/`'PEDIDO SHOWROOM'` en el flujo de carrito del showroom. El
operador lo reemplaza después en DUX a mano.

**Cambio (frontend).**
- `crear-pedido-dialog`: nuevo `signal` editable `pedidoRazonSocial` con su
  input de texto (reemplaza `apellidoRazonSocialFijo`). El payload manda
  `apellidoRazonSocial: this.pedidoRazonSocial().trim()`.
- Flujo showroom (`showroom-page`): mismo tratamiento — input editable para la
  razón social al crear el pedido, sin placeholder fijo.
- Default vacío. Si el autocompletado por CUIT/razón social (item 3) encuentra
  cliente, precarga la razón social guardada.
- Validación: requerido (DUX lo exige). Botón crear deshabilitado si está vacío.

**Backend.** No cambia: `construirPayloadDux` ya manda
`request.apellidoRazonSocial()` tal cual ([:1203](../../../showroom-backend/src/main/java/ar/com/leo/showroom/showroom/service/ShowroomService.java)).

---

## 3 + 4. Tabla de clientes formal por CUIT + autocompletado

**Decisión.** Extender `ClienteMaster` (una sola tabla) con CUIT único opcional.
Los clientes de presupuesto siguen **informales** (snapshot + agrupación por
teléfono); solo se "formalizan" al generar el pedido con CUIT.

**Cambios (backend).**
- `ClienteMaster`: el campo `nroDoc` (ya existe, Long) recibe un **índice
  ÚNICO** `uk_cliente_master_nro_doc`. (El plan barajó NO único por el caso
  multi-local, pero el usuario pidió CUIT único; se verificó que `cliente_master`
  estaba vacía, sin duplicados que rompieran `ddl-auto`.) `nro_doc` es nullable y
  MySQL permite múltiples NULL en índice único → los informales sin CUIT
  conviven. El **upsert** por CUIT (`registrarDesdePedido`) reusa la fila del CUIT
  (no duplica); el editor manual valida colisión y lanza `ConflictException`.
- Nuevo campo `razonSocial` (length 150) — para `apellido_razon_social` del
  pedido, distinto de `nombre`. (Hoy el maestro solo tiene `nombre`.)
- `ClienteMasterService`:
  - `buscarParaAutocompletar(Long nroDoc)` (ya existe) → priorizar la fila del
    maestro con ese CUIT; fallback al último pedido con ese CUIT.
  - **Nuevo** `buscarPorRazonSocial(String q)` → autocompletado por nombre/razón
    social (LIKE, no eliminados), devuelve lista de candidatos.
  - **Upsert al crear pedido**: cuando se crea un pedido con CUIT, hacer
    upsert por CUIT en `ClienteMaster` (crea o actualiza razón social, nombre,
    email, tel, rubro, domicilio, provincia, localidad). Esto es lo que hace que
    "se guarde en la tabla clientes". Se dispara desde `ShowroomService.crearPedido`
    (no en presupuestos).
- `ClienteAutocompletarDTO`: agregar `razonSocial`.
- `ClienteMasterController`: ya tiene `GET /cliente-master/por-cuit/{nroDoc}`;
  agregar `GET /cliente-master/buscar?q=` para autocompletado por razón social.

**Cambios (frontend).** En `crear-pedido-dialog` y `showroom-page`:
- CUIT: al completar, autocompletar (ya implementado, ahora pega contra el
  maestro por CUIT).
- Razón social: `p-autoComplete` que sugiere clientes guardados por nombre; al
  elegir uno, precarga los demás campos vacíos.
- Solo se completan campos **vacíos** (no se pisa lo que el operador ya tipeó).

**Migración.** `ddl-auto=update` agrega columna `razon_social` y el índice
único. Sin Flyway. Los CUIT duplicados preexistentes en `cliente_master`
romperían la creación del índice único → verificar antes (query de duplicados);
si los hay, decidir cuál conservar. (Probablemente no hay porque hoy el CUIT no
era clave.)

---

## 5. Ordenar el carrito por producto y precio

**Alcance.** El carrito (showroom y presupuesto) hoy se muestra en orden de
agregado. Permitir ordenar por columna **producto** (descripción A-Z / Z-A) y
**precio** (asc/desc).

**Cambio (frontend, sin backend).** El carrito es una lista en memoria. Agregar
ordenamiento local: encabezados de columna clickeables (o un control de orden
igual al de resultados de búsqueda) que reordenan la vista del carrito sin
alterar el orden de persistencia. Estado de orden en un `signal`; la lista
renderizada sale de un `computed` que aplica el sort. Mismo patrón en
`showroom-page` y `presupuestos-page`.

> Nota: el orden de los ítems en el carrito **no** cambia el pedido/presupuesto
> generado (los ítems van igual); es solo orden de visualización.

---

## 6. Filtros de búsqueda: proveedor y simple/combo

**Alcance.** Junto al control de ordenamiento (en showroom y presupuestador),
agregar filtros por **proveedor** y **simple/combo**. Estos datos vienen de DUX
y hoy **no** se guardan en `producto_cache`.

**Paso 0 — descubrimiento (bloqueante).** `DuxItem` ignora campos desconocidos y
la referencia DUX no documenta proveedor/combo. Primer paso: una llamada
read-only `GET /items?limit=1` (o inspección de la respuesta cruda) para
confirmar los nombres reales de los campos de proveedor y de combo/compuesto. Si
DUX **no** los expone en `/items`, se evalúa endpoint alternativo o se ajusta el
alcance con el usuario.

**Cambios (backend), asumiendo que DUX los provee.**
- `DuxItem`: mapear los campos descubiertos (ej. `proveedor`/`cod_proveedor`,
  y el flag de combo/compuesto).
- `ProductoCache`: nuevas columnas `proveedor` (String, length ~150, indexada)
  y `esCombo` (Boolean). Poblarlas en `CatalogoSyncService.aplicarItem`.
- `buscarCatalogo(q, page, size, sortField, sortOrder, proveedor, soloCombos)`:
  agregar filtros opcionales al query (proveedor exacto, combo sí/no).
- Endpoint para listar proveedores distintos (para poblar el dropdown del
  filtro): `GET /api/showroom/catalogo/proveedores`.

**Cambios (frontend).** Junto al input de ordenamiento, dos controles: `p-select`
de proveedor (opciones desde el nuevo endpoint) y un toggle/`p-select`
simple/combo. Disparan la búsqueda con los nuevos parámetros. Mismo bloque en
showroom y presupuestador.

**Riesgo.** Si DUX no informa combo en `/items`, este sub-item queda parcial
(solo proveedor) hasta resolver la fuente. Se confirma tras el Paso 0.

**Resolución (jun-2026):** el Paso 0 (llamada real a `GET /items`) confirmó que
DUX NO expone combo (campos: `cod_item, item, codigos_barra, rubro, sub_rubro,
marca, proveedor, costo, porc_iva, precios, stock, habilitado, codigo_externo,
fecha_creacion, imagen_url, ctd_unidades_por_bulto`). Decisión del usuario:
**descartar el filtro de combo**, dejar solo el de proveedor (ya implementado).

---

## Orden de implementación sugerido

1. Item 1 (IVA a DUX) — aislado, backend + test.
2. Item 2 (razón social editable) — frontend.
3. Item 5 (orden de carrito) — frontend.
4. Item 6 — Paso 0 (descubrir campos DUX) → entidad/sync/filtros.
5. Item 3/4 (clientes por CUIT) — entidad + autocompletado + upsert + frontend.

## Decisiones acordadas (2026-06-11)

- **Clientes:** extender `ClienteMaster` con CUIT único opcional (una sola
  tabla). NO tabla nueva separada.
- **Clientes de presupuesto:** siguen informales; se formalizan (upsert por
  CUIT) recién al generar el pedido.
- **IVA a DUX:** subir por perfil (DUX factura lo que paga el cliente; menos en
  líneas sin IVA).

## Restricciones a respetar

- Lista **KT GASTRO read-only** en DUX: nunca modificar precios ni items en DUX.
- Foco del scan: cualquier dialog/control nuevo debe devolver el foco al
  cerrarse para no romper la pistola QR.
- PrimeNG: usar `class`, no `styleClass`. Evitar `backdrop-blur`.
