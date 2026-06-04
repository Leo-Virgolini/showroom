# Mejoras de la página principal del showroom

Fecha: 2026-06-04

Tres features, aprobadas para implementar juntas:
A) Selector de forma de pago en scan + visor (con 2 flags de referencia).
B) Descuento manual en el carrito del showroom.
C) Permitir agregar al carrito más cantidad que el stock disponible.

## A) Selector de forma de pago (scan + visor)

### Modelo
- `FormaPago.precioReferencia` se renombra a **`precioReferenciaMenaje`** reusando la
  columna existente (`@Column(name="precio_referencia")`) — sin migración; los
  valores actuales pasan a "referencia menaje".
- Nueva propiedad **`precioReferenciaMaquinaria`** (columna nueva nullable).
- Helper **`formaDestacada(esMaquinaria)`**: de las formas activas con el flag del
  perfil (menaje o maquinaria), la de menor `orden`. Reemplaza a la "primaria" única.

### Config (formas de pago)
- El checkbox/columna "Precio ref." pasa a **dos**: "Ref. menaje" y "Ref. maquinaria"
  (dialog + tabla).

### Showroom — scan
- **Selector** (p-select) con todas las formas activas, arriba del precio.
- Un **precio destacado**: el del producto con la forma elegida (según rubro, vía
  `perfilForma` + `precioPorForma`); si es cuotas, "N × $cuota".
- **"Comprá más y ahorrás"**: cada escalón muestra el precio de la forma elegida con
  ese descuento (uno por escalón, no los 3).
- **Sticky**: `formaScanSeleccionada` signal. Mientras el operador no elija, se usa
  `formaDestacada(esMaq del producto)`; al elegir, se mantiene entre productos.
- Sin badges c/IVA (ya quitados).

### Visor
- Muestra el precio de la forma recibida por SSE; default `formaDestacada(esMaq)`.
- Escalones con la forma elegida; pill "MEJOR PRECIO" si la elegida es la más barata.

### Sincronización (SSE)
- Backend: endpoint `POST /api/showroom/visor/forma` (recibe la forma del operador)
  que emite el evento SSE **`visor-forma` { formaId }** en el canal del operador
  (mismo canal por username que usa `scan-visor`).
- Showroom publica el `formaId`: (a) al cambiar la forma, (b) al escanear (salvo
  `publicarVisor=false`).
- Visor: mantiene el último `formaId` recibido (sticky); sin ninguno, usa el default.

### Presupuestador / Cotizador (coherencia)
- Presupuestador: el "precio efectivo" por ítem usa `formaDestacada(esMaq del ítem)`.
- Cotizador: la forma destacada se elige por tasa de IVA (21% → ref. menaje, 10,5%
  → ref. maquinaria).

## B) Descuento manual en el carrito del showroom
- Descuento **por ítem (%)** editable en cada línea del carrito + descuento **global
  (%)** (atajo que setea el % de todos los ítems, como el presupuestador; reflejo,
  no aditivo).
- **Reemplaza la escala**: si hay descuento manual (>0), el descuento automático por
  escala se ignora para ese pedido. Si el manual es 0, sigue aplicando la escala.
- Los descuentos viajan a DUX como `porc_desc` por ítem (igual que hoy).
- El total/desglose del carrito recalcula con el descuento efectivo por ítem.

## C) Permitir cantidad > stock
- En **scan, visor y presupuestador**: quitar el tope de cantidad = stock (tope alto
  9999). Se puede agregar más de lo disponible.
- Se mantienen las notificaciones: "Stock: X", "Sin stock". Se agrega un aviso
  **informativo (no bloqueante)** cuando la cantidad supera el stock disponible.
- El backend ya acepta el ítem como pendiente de reposición (`forzar`); reusar.

## Orden de implementación
1. Modelo (2 flags) + config UI.
2. `formaDestacada` + ajuste presupuestador/cotizador.
3. Selector scan + visor + SSE.
4. Descuento manual (carrito showroom).
5. Cantidad > stock (scan/visor/presupuestador).

## Verificación
- `mvn test` + `npx ng build` en verde por fase.
- Chequeo manual: default por perfil (menaje vs maquinaria), sticky, sincronización
  visor; descuento manual reemplaza escala y va a DUX; agregar cantidad > stock con
  aviso.
