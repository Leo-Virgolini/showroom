# Congelar el perfil de IVA al convertir un presupuesto en pedido

Fecha: 2026-06-27

## Objetivo

Cuando un presupuesto se convierte en pedido, **congelar el perfil
(menaje/maquinaria) con que se cotizó cada ítem**, usando el flag
`precioReferenciaConIva` que el presupuesto ya persiste — en vez de re-derivar el
perfil por el rubro contra la lista configurable de "rubros sin IVA" (que puede
haber cambiado entre la cotización y la conversión).

## Contexto actual

- En `PedidoService.crearPedido`, por cada ítem: `esMaq = rubro ∈ rubrosSinIva`
  (lista configurable). Ese `esMaq` determina **dos** cosas:
  `recargoItem = recargoPerfil(formaPago, esMaq)` y
  `aplicaIvaItem = aplicaIvaPerfil(formaPago, esMaq)`.
- El presupuesto persiste `precioReferenciaConIva` por ítem
  (`true`=menaje/con IVA, `false`=maquinaria/sin IVA), pero **el pedido no lo
  consume**: el flag no viaja en `CrearPedidoRequestDTO.Item` y `crearPedido`
  re-deriva por rubro.
- Si la lista de rubros sin IVA cambió entre cotizar y convertir, el pedido
  factura con un perfil distinto al cotizado.

## Principio

Lo que se congela es el **perfil `esMaq`**, no el IVA suelto: el IVA y el recargo
finales dependen de la **forma de pago elegida al crear el pedido** (que puede
diferir de la del presupuesto), y se aplican sobre el perfil congelado. La
semántica del flag es `esMaq = !precioReferenciaConIva`.

## Diseño

### Backend

1. **`CrearPedidoRequestDTO.Item`**: agregar `Boolean precioReferenciaConIva`
   (nullable). Null = no congelar (showroom normal o presupuesto viejo).

2. **`PedidoService.crearPedido`**: extraer la decisión del perfil a un helper
   testeable y usar el flag congelado cuando corresponde. Pseudocódigo del
   reemplazo del cálculo de `esMaq` (~línea 564):

   ```java
   boolean esMaq = resolverEsMaq(
           request.origenPresupuesto(), it.precioReferenciaConIva(), rubroItem, rubrosMaq);
   ```

   con:

   ```java
   /** Perfil (maquinaria/menaje) del ítem. En pedidos de presupuesto que traen
    *  el snapshot `precioReferenciaConIva`, se CONGELA el perfil con que se
    *  cotizó (esMaq = !precioReferenciaConIva), para no re-derivarlo por rubro
    *  si la lista de rubros sin IVA cambió. En el showroom normal, o si el
    *  presupuesto es viejo (flag null), se deriva por rubro como hasta ahora. */
   static boolean resolverEsMaq(boolean origenPresupuesto, Boolean precioReferenciaConIva,
                                String rubroItem, Set<String> rubrosMaq) {
       if (origenPresupuesto && precioReferenciaConIva != null) {
           return !precioReferenciaConIva;
       }
       return !rubrosMaq.isEmpty() && rubrosMaq.contains(normalizarRubro(rubroItem));
   }
   ```

   `recargoItem` y `aplicaIvaItem` siguen calculándose con ese `esMaq` (sin otros
   cambios). El precio base, descuentos y el resto del loop no cambian.

### Frontend

3. **`crear-pedido-dialog.ts`**: el ítem del detalle del presupuesto ya trae
   `precioReferenciaConIva` (`PresupuestoDetalle.items`, `models.ts`). Propagarlo:
   - en el shape del signal `itemsDelPresupuesto` (~línea 178) y en el mapeo desde
     `det.items` (~línea 388);
   - en el `items.map(...)` que arma el `CrearPedidoRequest` (~línea 717):
     `precioReferenciaConIva: it.precioReferenciaConIva ?? undefined`.

4. **`CrearPedidoRequest.Item` (models.ts)**: agregar
   `precioReferenciaConIva?: boolean`.

### Documentación

5. Actualizar el comentario de `GenerarPresupuestoRequestDTO.Item.precioReferenciaConIva`
   (que hoy dice "el pedido NO lo consume"): ahora **sí** se consume para congelar
   el perfil en pedidos de presupuesto.

## Casos / compatibilidad

- **Pedido de presupuesto con flag** → perfil congelado (esMaq = !flag).
- **Presupuesto viejo sin flag** (null) → fallback por rubro (igual que hoy).
- **Showroom normal** (`origenPresupuesto = false`) → siempre por rubro (sin cambio).
- El cambio solo afecta el perfil cuando la lista de rubros sin IVA **difiere**
  de la del momento de cotización; si no cambió, el resultado es idéntico.

## Testing

- Test unitario puro de `resolverEsMaq` (sin Spring): congela con flag en
  presupuesto; fallback por rubro sin flag / en showroom; respeta el flag aunque
  el rubro diga lo contrario (el caso que motiva el congelado).

## Out of scope (YAGNI)

- No se cambia el flujo del showroom normal.
- No se retro-rellenan presupuestos viejos (sin flag → por rubro).
- No se cambia el precio base ni el cálculo de descuentos/recargos más allá del
  perfil.

## Verificación

- Backend en verde (`mvn -f showroom-backend/pom.xml test`) + el nuevo test de
  `resolverEsMaq`. Frontend compila.
- Manual: cotizar un ítem de maquinaria (sin IVA), cambiar la config de rubros
  sin IVA, convertir el presupuesto en pedido → el ítem se factura sin IVA (como
  se cotizó), no según la config nueva.
