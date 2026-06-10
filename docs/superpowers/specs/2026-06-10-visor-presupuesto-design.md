# Visor de presupuesto + sesión de cliente compartida

**Fecha:** 2026-06-10
**Estado:** Aprobado, listo para implementar

## Objetivo

Agregar un **visor read-only para el armado de presupuestos**, análogo al visor del
showroom pero que muestra el **carrito completo del presupuesto** (todos los ítems +
total + formas de pago) en vez de producto-a-producto. Se ve en el celular del cliente,
se actualiza **en vivo** mientras el operador arma el presupuesto, y **no permite editar
ni quitar** nada.

Además, el showroom y el presupuestador pasan a **compartir la misma sesión de cliente**
(`SesionShowroom` por operador), con la badge "Atendiendo a X / Nuevo cliente / Finalizar"
también en la página del presupuestador.

## Decisiones tomadas (brainstorming)

1. **Cliente compartido, pero opcional.** Showroom y presupuestador comparten la
   `SesionShowroom` del operador. La badge aparece en ambas pantallas. Usarla es opcional:
   el presupuesto se arma y se muestra en el visor con o sin sesión y con o sin cliente.
2. **Fuente de verdad del nombre = el presupuesto.** El nombre que va al PDF y al visor es
   el campo propio `clienteNombre` del presupuesto, editable y opcional. Si hay sesión
   activa y el campo está vacío, se **prellena** con el nombre de la sesión (conveniencia,
   mismo patrón `aplicarSesion` del showroom); el operador lo puede sobreescribir o borrar
   (caso: presupuesto para un cliente ausente distinto del que se atiende, o sin cliente).
   Teléfono y email se siguen cargando en el dialog "Datos del cliente".
3. **Finalizar/cambiar = igual que el showroom.** Una única sesión global por operador.
   Finalizar o cambiar de cliente desde el presupuestador cierra la sesión y dispara
   `SesionCerradaEvent` (vacía el carrito del showroom). Sin lógica nueva de sesión en el
   backend — se reusa `SesionShowroomService` tal cual.
4. **Visor en vivo (espejo automático).** Cada cambio del armado se refleja al instante en
   el visor (con debounce para no inundar de requests).
5. **Contenido completo.** Ítems (foto/descripción, cantidad, precio unitario, subtotal de
   línea ya con descuento), TOTAL, y desglose de formas de pago con la "mejor" resaltada
   (mismo criterio que `formasPagoFooter`). Vista **agregada** siempre, aunque el armado
   esté en modo individual.
6. **Reuso del stream SSE existente.** El visor de presupuesto abre el mismo endpoint
   `/api/showroom/visor/{username}/events` y escucha solo el evento nuevo `presupuesto-visor`.
   No se toca nginx, Docker, CORS ni security (el path `/visor/**` ya está cubierto).

## Arquitectura

### Reuso de infraestructura existente (sin cambios)

- **nginx**: el location regex `^/api/showroom/visor/[^/]+/events$` (sin buffering, timeout
  24h) ya cubre el stream. La ruta nueva del frontend `/visor-presupuesto/:username` cae en
  el SPA fallback `try_files ... /index.html`. **No se modifica `nginx.conf`.**
- **SecurityConfig**: `/api/showroom/visor/**` ya es `permitAll` + CSRF-exempt. Los endpoints
  nuevos van bajo `/visor/...`, así que **no se modifica**.
- **CorsConfig**: `http://*:*` / `https://*:*` ya abierto. **No se modifica.**
- **SyncEventService**: se reusa `publishTo(username, evento, payload)` para emitir por canal
  de operador. **No se modifica.**
- **SesionShowroomService**: se reusa `iniciar` / `cancelar` / `obtenerActiva` /
  `sesion-updated` tal cual. **No se modifica.**
- **VisorConfig** (`/config/visor`, `baseUrl`): se reusa para armar la URL del QR (resuelve
  el caso IP-vs-DNS para celulares).

### Backend — piezas nuevas (mínimas)

**`PresupuestoVisorService`** (`presupuesto/visor/` o junto a `VisorService`):
- Estado en memoria: `ConcurrentHashMap<String username, PresupuestoVisorDTO>` con el último
  snapshot publicado por operador.
- `publicar(String username, PresupuestoVisorDTO snapshot)`: guarda el snapshot y emite
  `eventService.publishTo(username, "presupuesto-visor", snapshot)`.
- `obtener(String username)`: devuelve el snapshot guardado o un snapshot vacío.
- `limpiar(String username)`: guarda+emite un snapshot vacío (al salir del presupuestador /
  vaciar).

**DTO `PresupuestoVisorDTO`**:
```java
record PresupuestoVisorDTO(
    String clienteNombre,                 // null/blank => "Presupuesto" genérico
    List<ItemVisor> items,
    BigDecimal total,                     // total efectivo (forma de referencia)
    List<FormaPagoVisor> formasPago,      // todas, ya calculadas
    int indiceMejorPrecio                 // -1 si no hay ganadora
) {
  record ItemVisor(
      String sku, String descripcion, String imagenUrl,
      int cantidad,
      BigDecimal precioUnitario,          // precio de referencia unitario
      BigDecimal subtotalLinea            // unitario * (1 - desc) * cantidad
  ) {}
  record FormaPagoVisor(
      Long id, String nombre, BigDecimal precioFinal,
      Integer cantidadCuotas, String descripcion
  ) {}
}
```

**Endpoints nuevos en `ShowroomController`** (bajo `/visor/...`, mismo patrón que `/visor/forma`):
- `POST /api/showroom/visor/presupuesto` — body `PresupuestoVisorDTO`; resuelve el operador
  por `Authentication` (el operador autenticado publica). Llama `presupuestoVisorService.publicar`.
- `GET /api/showroom/visor/{username}/presupuesto` — público; hidratación inicial; valida
  operador con `validarOperadorVisor(username)` (404 si no existe/inactivo); devuelve el snapshot.

### Frontend — piezas nuevas

**Ruta** en `app.routes.ts`:
```ts
{
  path: 'visor-presupuesto/:username',
  loadComponent: () =>
    import('./showroom/visor-presupuesto-page/visor-presupuesto-page')
      .then((m) => m.VisorPresupuestoPage),
}
```

**Componente `VisorPresupuestoPage`** (standalone, OnPush, sin auth):
- Lee `:username` del path. Si `GET .../presupuesto` da 404 → overlay "URL inválida" (igual
  que `VisorPage`).
- Hidratación inicial vía `GET /visor/{username}/presupuesto`.
- Suscripción al evento SSE `presupuesto-visor` (ver service abajo) → actualiza el snapshot.
- Render: header KT GASTRO + "Presupuesto para {cliente}" (o "Presupuesto" si vacío), lista
  de ítems, TOTAL, formas de pago con la mejor resaltada. Estado "esperando…" si no hay ítems.
  Reusa estilos/tono de `visor-page` adaptados a lista. 100% read-only.

**`BackendStatusService`** (extensión):
- Nuevo `Subject` + `Observable presupuestoVisorEvents$`.
- Handler del evento SSE `presupuesto-visor` en el `EventSource` (junto a `scan-visor`, etc.).
- El visor de presupuesto reusa `conectarComoVisor(username)` (ya abre `/visor/{username}/events`).

**`ShowroomService`** (extensión):
- `publicarPresupuestoVisor(snapshot): Observable<void>` → `POST /visor/presupuesto`.
- `visorObtenerPresupuesto(username): Observable<PresupuestoVisorDTO>` → `GET /visor/{username}/presupuesto`.

**`presupuestos-page` (modificaciones):**
- **Sesión compartida + badge:** leer la sesión activa al iniciar (`obtenerSesionActiva`),
  suscribirse a `sesionEvents$`, exponer `sesionActiva` y la badge con "Nuevo cliente" /
  "Finalizar" reusando el patrón de `showroom-page` (`iniciarSesion`, `cancelar`, dialog
  nuevo cliente). Al aplicar sesión, prellenar `clienteNombre` solo si está vacío.
- **Publicación en vivo:** un `Subject` que se dispara ante cada cambio relevante (items,
  cantidad, descuento, descuento global, formas de pago, clienteNombre) con
  `debounceTime(400)` → arma el `PresupuestoVisorDTO` y llama `publicarPresupuestoVisor`.
  Snapshot derivado de los computed existentes (`items`, `totalReferencia`,
  `formasPagoFooter`/`formasPagoCalculadas`, `indiceMejorPrecio`, `precioMostrado`,
  `totalLinea`).
- **QR:** botón "QR presupuesto" en el toolbar; reusa el dialog + generación de QR del
  showroom (`qrcode`, `VisorConfig.baseUrl`). URL:
  `{baseUrl || window.location.origin}/visor-presupuesto/{username}`.
- **Limpieza:** al destruir la página o al `vaciar()`, publicar snapshot vacío
  (`limpiar`) para no dejar un presupuesto viejo en el visor.

## Flujo de datos (en vivo)

```
[Operador arma presupuesto en /presupuestos]
   cambio (item/cantidad/descuento/forma/cliente)
        ↓ (debounce 400ms)
   POST /api/showroom/visor/presupuesto  (auth: operador)
        ↓
   PresupuestoVisorService.publicar(username, snapshot)
        ├─ guarda snapshot en memoria (Map<username, dto>)
        └─ SyncEventService.publishTo(username, "presupuesto-visor", snapshot)
              ↓ SSE
   [Celular en /visor-presupuesto/{username}] actualiza la vista

[Celular abre el QR]
   GET /api/showroom/visor/{username}/presupuesto  (público, 404 si username inválido)
        ↓ snapshot actual (o vacío) → hidratación inicial
```

## Manejo de errores y bordes

- `GET /visor/{username}/presupuesto` con username inexistente/inactivo → 404 → overlay
  "URL inválida" en el visor.
- Reconexión SSE: la maneja `BackendStatusService` (reusado).
- Multi-pantalla del operador (showroom + presupuestador abiertos): publican en el mismo
  canal con eventos distintos (`scan-visor` vs `presupuesto-visor`); cada visor filtra el suyo.
- Cambio/finalización de sesión: como en el showroom (vacía carrito showroom). El armado del
  presupuesto (signals locales) **no se vacía** automáticamente al cambiar de cliente — lo
  controla el operador con "Vaciar" (decisión de UX confirmada).
- Visor sin ítems o sin cliente: estados válidos ("esperando…" / "Presupuesto" sin nombre).

## Testing

- **Backend:** test de `PresupuestoVisorService` (guardar/recuperar/limpiar snapshot, publish
  al username correcto); test de los endpoints (publicar autenticado, hidratar público,
  404 username inválido).
- **Frontend:** typecheck (`tsc --noEmit`) + verificación manual en navegador/celular
  (armar presupuesto → reflejo en vivo; QR → hidratación; finalizar sesión → badge + efecto).

## Fuera de alcance (YAGNI)

- Modo "individual" en el visor (siempre muestra la vista agregada).
- Cualquier acción del cliente desde el visor de presupuesto (es 100% read-only; a diferencia
  del visor del showroom, no hay "agregar al carrito").
- Persistencia del snapshot del visor en BD (vive en memoria; se pierde en restart, igual que
  el carrito del showroom).
- Auto-vaciado del armado al cambiar de cliente.
