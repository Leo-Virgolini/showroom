# Datos completos de cliente en `/clientes` + fix link a pedidos

**Fecha:** 2026-06-11
**Estado:** Aprobado para implementación

## Problema

La tabla de `/clientes` (`presupuestos-clientes-page`) solo muestra
email, teléfono, nombre, rubro, contadores, fechas y total. **No expone el
CUIT ni los datos de envío** (domicilio, provincia, localidad) que el sistema
**sí guarda** en los pedidos.

Además, el deep-link "Ver pedidos" desde `/clientes` **no filtra
correctamente**: navega a `/pedidos?q=<fragmento de teléfono>`, pero la query
`q` de pedidos matchea contra `id`, `nroDoc`, `apellidoRazonSocial` y `nombre`
— **no contra `telefono`**. Por eso casi nunca encuentra los pedidos del
cliente. (El link a presupuestos sí funciona porque su búsqueda incluye
`clienteTelefono`.)

## Objetivo

1. Mostrar en la tabla de clientes **todos los datos guardados**, agregando
   CUIT y datos de envío como **columnas nuevas ordenables**.
2. Permitir **editar** esos campos en el maestro de clientes (`ClienteMaster`),
   sin tocar el historial.
3. **Arreglar** el filtro del link "Ver pedidos".

## Origen de los datos (decisión clave)

CUIT (`tipoDoc`+`nroDoc`), `domicilio`, `codigoProvincia` e `idLocalidad`
solo existen en **pedidos** (`PedidoShowroom`); los presupuestos
(`PresupuestoComercial`) no tienen esos campos.

→ Esos campos se toman del **pedido más reciente** del cliente, aunque exista
un presupuesto posterior. El "movimiento canónico" (nombre/email/rubro/total)
sigue tomándose del movimiento más nuevo entre presupuestos y pedidos, como
hoy. El maestro (`ClienteMaster`), si tiene valores, pisa los derivados.

Un cliente que solo tiene presupuestos no tendrá CUIT/envío derivados: las
celdas quedan **en blanco** (sin guión) hasta que el operador los complete
editando el cliente.

## Backend

### `ClienteMaster` (entidad)
Agregar columnas nullable (creadas automáticamente por `ddl-auto=update`):
- `tipo_doc` (varchar 10)
- `nro_doc` (bigint)
- `domicilio` (varchar 200)
- `codigo_provincia` (varchar 10)
- `id_localidad` (varchar 20)

### `ActualizarClienteRequestDTO` + `ClienteMasterService.upsert`
Agregar los mismos campos al request y persistirlos en el upsert
(`blankToNull` para los strings; `nroDoc` como `Long` nullable).

### `ClientePresupuestosDTO`
Agregar:
- `tipoDoc` (String), `nroDoc` (Long)
- `domicilio` (String)
- `codigoProvincia` (String), `provinciaNombre` (String)
- `idLocalidad` (String), `localidadNombre` (String)

### `AgregadorCliente` (en `PresupuestoComercialService`)
Llevar un snapshot del **pedido más reciente** (separado del canónico):
al `agregarPedido`, si el pedido es más nuevo que el último pedido visto,
capturar `tipoDoc`, `nroDoc`, `domicilio`, `codigoProvincia`, `idLocalidad`.
`toDTO()` los incluye (los nombres de provincia/localidad se resuelven en el
caller, ver abajo).

### `listarClientes` — resolución de nombres
Para no hacer N+1:
- Cargar todas las provincias una vez → `Map<codIso, nombre>` (case-insensitive).
- Juntar todos los `idLocalidad` no nulos de los agregadores y batch
  `localidadRepo.findAllById(ids)` → `Map<id, nombre>`.
- Al armar cada DTO, completar `provinciaNombre`/`localidadNombre` desde esos
  mapas (null si no se resuelve).

### `aplicarMaster`
Extender para pisar `tipoDoc`/`nroDoc`/`domicilio`/`codigoProvincia`/
`idLocalidad` cuando el master los tiene no-nulos (mismo patrón que
nombre/email/rubro). Si el master setea provincia/localidad, recalcular sus
nombres desde los mismos mapas.

### Fix del link a pedidos
En `PedidoShowroomRepository`, agregar al `OR` de la query `q`:
```
or lower(coalesce(p.telefono, '')) like concat('%', lower(:q), '%')
```
Simétrico al `clienteTelefono` del historial de presupuestos. Mismas
características de robustez (matchea dígitos consecutivos sin separadores).

## Frontend

### Modelo (`models.ts`)
- `ClientePresupuestos`: + `tipoDoc`, `nroDoc`, `domicilio`, `codigoProvincia`,
  `provinciaNombre`, `idLocalidad`, `localidadNombre` (todos nullable).
- `ActualizarClienteRequest`: + `tipoDoc`, `nroDoc`, `domicilio`,
  `codigoProvincia`, `idLocalidad`.

### Tabla `/clientes`
Agregar 4 columnas **ordenables** (orden client-side de PrimeNG, ya en uso):
- **CUIT** — muestra `nroDoc` (con `tipoDoc` como contexto); sort field `nroDoc`.
- **Domicilio** — sort field `domicilio`.
- **Localidad** — `localidadNombre`; sort field `localidadNombre`.
- **Provincia** — `provinciaNombre`; sort field `provinciaNombre`.

Celdas vacías → en blanco (sin `—`) para estos 4 campos. La tabla queda con
13 columnas: envolverla en contenedor con scroll horizontal
(`overflow-x-auto`) para que no rompa el layout. Ajustar el `colspan` del
`emptymessage` (de 9 a 13).

### Diálogo "Editar cliente"
Agregar campos (debajo del rubro, antes de notas):
- **Tipo doc**: `p-select` con DNI/CUIT/CUIL (+ clear).
- **N° doc**: input numérico (hasta 11 dígitos).
- **Domicilio**: input de texto.
- **Provincia → Localidad**: dos `p-select` en cascada, reusando el patrón de
  `crear-pedido-dialog` (cargar provincias al abrir; al cambiar provincia,
  cargar localidades vía `api.obtenerLocalidades(codIso)`). Pre-seleccionar
  con `codigoProvincia`/`idLocalidad` del cliente al abrir.

`guardarEdicion` incluye los nuevos campos en el payload.

### CSV
Agregar a la exportación las columnas extra: CUIT, Domicilio, Localidad,
Provincia (después de Rubro). Son campos "extra" que Marketing Nube ignora o
mapea — no rompen la importación.

## Fuera de alcance (YAGNI)
- No se tocan los PDFs ni los snapshots históricos de pedidos/presupuestos.
- No se agrega categoría fiscal.
- No se cambia la agrupación por teléfono ni el soft-delete.

## Verificación
- Backend: `mvn compile` / test del cálculo del agregador con un cliente que
  tiene un pedido viejo + presupuesto nuevo (CUIT/envío vienen del pedido).
- Frontend: `ng build` sin errores; columnas ordenables; editar y ver que
  persiste; deep-link "Ver pedidos" filtra por teléfono.
