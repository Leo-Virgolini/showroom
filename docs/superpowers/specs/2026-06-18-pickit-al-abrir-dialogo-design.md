# Generar el pickit externo al abrir el diálogo de pedido (flujo showroom)

**Fecha:** 2026-06-18

## Problema

Hoy el Excel del pickit externo (programa `pickit-y-etiquetas`) se genera
**después** de que el pedido se crea con éxito en DUX
([PedidoService.java:740](../../../showroom-backend/src/main/java/ar/com/leo/showroom/pedido/service/PedidoService.java)).
El operador tiene que esperar a que termine de cargar los datos del cliente,
confirmar, y a que DUX responda, antes de que el pickit empiece a generarse.

El pickit solo necesita los SKU + cantidades del carrito, que ya están
disponibles **antes** de cargar los datos del cliente. Se puede adelantar.

## Objetivo

Generar el Excel del pickit en el momento en que se **abre** el diálogo de
crear pedido (flujo showroom), en paralelo, para que esté listo mientras el
operador carga los datos del cliente.

Decisión del usuario: disparar **al abrir el diálogo** (máxima anticipación),
asumiendo el trade-off de que un pedido cancelado deje un .xlsx huérfano.

## Alcance

- **Solo el flujo showroom** (carrito → diálogo). El flujo presupuesto→pedido
  carga los ítems async al abrir, así que ahí no aplica la generación al abrir
  y se mantiene la generación post-pedido actual.

## Diseño

### Backend

1. **Refactor de `PickitExternoService`**: extraer de `generar(PedidoShowroom)`
   la lógica común (escribir el .xlsx de input con SKU+CANTIDAD, invocar el CLI,
   renombrar con prefijo `SHOWROOM-`) a un método que reciba una **lista de
   ítems crudos** `(sku, cantidad)` + un label para el log. `generar(PedidoShowroom)`
   pasa a delegar en él.

2. **Nuevo método async** que genera a partir de ítems crudos + `operador` +
   `clientId`, y publica el SSE `pickit-externo` con `pedidoId = null` (el record
   `PickitExternoEvent` ya acepta `Long` nulo).

3. **Nuevo endpoint** `POST /carrito/pickit-externo`:
   - Lee el carrito del operador autenticado (`CarritoService.obtener`).
   - Si el carrito está vacío → 400 (nada que generar).
   - Si el pickit no está configurado → 503 con el motivo
     (`motivoNoConfigurado`), igual que el endpoint de regeneración manual.
   - Si todo OK → lanza la generación async y responde 202/200 rápido. El
     resultado (path o error) llega por el SSE `pickit-externo`, con el
     `X-Client-Id` para que solo la PC origen auto-descargue.

### Frontend

4. **showroom-page**: unificar las 4 entradas que abren el diálogo
   (`abrirConfirmacion` sin verificación, con verificación OK, fallback de error,
   y `enviarIgualConExcedidos`) en un helper `abrirDialogPedidoShowroom()` que:
   - Setea `mostrarCrearPedidoShowroom.set(true)`.
   - Dispara `POST /carrito/pickit-externo`.

   Se dispara cuando el carrito ya tiene las cantidades finales (después del
   chequeo de stock, no antes).

5. **showroom.service.ts**: nuevo método `generarPickitDesdeCarrito()`.

6. **app.ts** (handler del SSE `pickit-externo`): cuando `pedidoId` es null,
   el toast muestra "Pickit del carrito" en vez de `pedido #null`. La
   auto-descarga no cambia (solo usa `outputPath` + `clientId`).

### Evitar doble generación

7. En [PedidoService.java:740](../../../showroom-backend/src/main/java/ar/com/leo/showroom/pedido/service/PedidoService.java),
   limitar la generación post-pedido al flujo presupuesto
   (`if (request.origenPresupuesto())`). En el flujo showroom ya se generó al
   abrir el diálogo.
   - **Fallback** si la generación al abrir falló: el botón "regenerar pickit"
     de la pantalla de pedidos sigue existiendo.

## Trade-offs aceptados

- Un diálogo abierto y luego cancelado deja un .xlsx de pickit huérfano en la
  carpeta de salida. Reabrir el diálogo regenera (archivo nuevo).
- Si la generación al abrir falla silenciosamente (pickit deshabilitado en ese
  momento, etc.), el pedido showroom queda sin pickit auto-generado; se cubre
  con el botón de regeneración manual.

## Testing

- Test del refactor de `PickitExternoService`: la generación desde ítems crudos
  produce el mismo .xlsx de input que desde un `PedidoShowroom` con los mismos
  ítems.
- Verificación manual: abrir el diálogo desde el showroom dispara la generación
  y la auto-descarga en la PC origen; crear el pedido NO genera un segundo
  archivo; el flujo presupuesto sigue generando post-pedido.
