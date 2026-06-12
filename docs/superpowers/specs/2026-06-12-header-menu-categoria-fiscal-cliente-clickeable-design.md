# Diseño: categoría fiscal, cliente clickeable e reorganización del header

Fecha: 2026-06-12

Tres modificaciones independientes sobre el frontend del showroom (con backend ya
preparado en una de ellas).

## 1. Categoría fiscal seleccionable al crear el pedido

### Contexto
- El backend ya acepta y valida `categoriaFiscal`: `CrearPedidoRequestDTO` valida con
  regex `^(CONSUMIDOR_FINAL|RESPONSABLE_INSCRIPTO|EXENTO|MONOTRIBUTISTA)?$` y
  `ShowroomService` usa el valor recibido o cae al default por empresa
  (`empresa.categoriaFiscalDefault()`).
- El tipo `CategoriaFiscal` con los 4 valores ya existe en
  `showroom-frontend/src/app/showroom/models.ts`.
- En el frontend está fijo/deshabilitado en los **dos** flujos de creación de pedido.

### Cambios
**`crear-pedido-dialog`** (presupuesto → pedido):
- Reemplazar el `<input disabled [value]="categoriaFiscalFija">`
  (`crear-pedido-dialog.html:99`) por un `p-select` con las 4 opciones.
- Nuevo signal `pedidoCategoriaFiscal = signal<CategoriaFiscal>('CONSUMIDOR_FINAL')`.
  Reemplaza la constante `categoriaFiscalFija`.
- En `confirmarCrearPedido()`, enviar `categoriaFiscal: this.pedidoCategoriaFiscal()`
  en vez del literal `'CONSUMIDOR_FINAL'` (línea ~606).
- Resetear a `'CONSUMIDOR_FINAL'` al cargar el detalle (en `cargarDetalle`), igual
  que el resto de los defaults del formulario.

**`showroom-page`** (pedido directo desde el carrito):
- `categoriaFiscalFinal` (hoy `readonly categoriaFiscalFinal: CategoriaFiscal =
  'CONSUMIDOR_FINAL'`) pasa a ser `readonly categoriaFiscal = signal<CategoriaFiscal>('CONSUMIDOR_FINAL')`.
- En `showroom-page.html:1102` reemplazar el input deshabilitado por un `p-select`.
- En el armado del payload (`showroom-page.ts:2537`), usar `this.categoriaFiscal()`.

### Opciones del select (compartidas)
```
[
  { label: 'Consumidor Final',       value: 'CONSUMIDOR_FINAL' },
  { label: 'Responsable Inscripto',  value: 'RESPONSABLE_INSCRIPTO' },
  { label: 'Exento',                 value: 'EXENTO' },
  { label: 'Monotributista',         value: 'MONOTRIBUTISTA' },
]
```
Default: `CONSUMIDOR_FINAL` (preserva el comportamiento actual). El campo sigue siendo
obligatorio; al tener default siempre hay un valor válido.

## 2. Cliente clickeable en los historiales → tabla de Clientes filtrada

### Contexto
- La página de clientes (`presupuestos-clientes-page`) ya navega *hacia* los
  historiales con `?q=<fragmento de teléfono>` (`verPresupuestos`, `verPedidos`)
  usando `fragmentoTelefono` (últimos 8 dígitos del teléfono normalizado).
- `pedidos-page` y `presupuestos-historial-page` ya leen el query param `q` al montar.
- `presupuestos-clientes-page` **NO** lee query params hoy: su signal `busqueda`
  arranca en `''`.

### Cambios
**`presupuestos-clientes-page.ts`**:
- Inyectar `ActivatedRoute` y, en el constructor, leer
  `route.snapshot.queryParamMap.get('q')`; si existe, `this.busqueda.set(q)`.
  Mismo patrón exacto que pedidos-page / presupuestos-historial-page. El filtro
  client-side `clientesFiltrados` ya matchea por razón social / nombre / email /
  teléfono / CUIT, así que el `q` sembrado filtra solo.

**`pedidos-page.html` (columna Cliente, ~línea 192)**:
- El nombre del cliente pasa a ser clickeable (botón/anchor) que llama a un método
  `verCliente(p)` → navega a `/clientes` con `queryParams: { q: <filtro> }`.
- Filtro: últimos 8 dígitos de `p.telefono` si existe; si no, `String(p.nroDoc)`;
  si tampoco, `p.nombre`. (El pedido resumen tiene `telefono` y `nroDoc`.)
- Solo clickeable cuando hay un valor de filtro; si `nombreCliente(p)` es null
  muestra "—" no clickeable.

**`presupuestos-historial-page.html` (columna Cliente, ~línea 137)**:
- Igual: `p.clienteNombre` clickeable → `/clientes?q=<filtro>`.
- Filtro: últimos 8 dígitos de `p.clienteTelefono` si existe; si no, `p.clienteNombre`.

### Helper de filtro
Reutilizar la lógica de `fragmentoTelefono` (últimos 8 dígitos sobre solo-dígitos).
Cada página implementa su `verCliente(...)` con su propia fuente de teléfono/CUIT.
Navegación con `Router.navigate(['/clientes'], { queryParams: { q } })`.

### Estilo del link
Texto del cliente con subrayado sutil (`hover:underline` + `cursor-pointer` +
`text-primary`/color de la página) y `pTooltip="Ver ficha del cliente"`. Mantener el
`truncate`/tooltip de nombre existente donde aplique.

## 3. Reorganización del header con MenuBar

### Contexto
- Hoy la navegación global vive en `MoreMenu`: un `p-menu` popup disparado por un
  botón "Más", encapsulado dentro de `TopActions` (`app-top-actions`), que está en
  el toolbar de todas las páginas autenticadas.
- Cada página arma su propio `p-toolbar` con logo + contexto (sesión, etc.) en
  `#start` y acciones + `<app-top-actions />` en `#end`.
- Los botones "Nuevo Cliente" (inicia/asocia sesión de atención) y "QR" (visor) son
  context-específicos y viven en los toolbars de showroom y presupuestos.

### Cambios
Crear un componente nuevo `MainMenu` (`app-main-menu`) basado en **`p-menubar`**
(dropdowns) que reemplaza a `MoreMenu` en el mismo lugar dentro de `TopActions`.
Sigue apareciendo en todas las páginas vía `<app-top-actions />`. Se elimina/retira
el `MoreMenu` del template de `TopActions` (el archivo de `MoreMenu` puede borrarse si
no queda otro consumidor — verificar con grep antes de borrar).

`p-menubar` ofrece colapso responsive automático (hamburguesa) en pantallas chicas,
lo que sirve para el uso táctil del showroom.

### Estructura del menú (`MenuItem[]`)
Categorías de primer nivel con ícono + color distintivo; sub-ítems conservan los
colores por destino que ya define el `MoreMenu` actual (vía `iconClass` y
`styleClass` del `MenuItem`, que es la API soportada del modelo — no confundir con el
atributo `styleClass` deprecado de los componentes).

| Categoría (color / ícono) | Sub-ítems → ruta |
|---|---|
| **PEDIDOS** (sky / `pi pi-receipt`) | Nuevo Pedido → `/` · Historial de Pedidos → `/pedidos` |
| **PRESUPUESTOS** (amber / `pi pi-file-edit`) | Nuevo Presupuesto → `/presupuestos` · Historial de Presupuestos → `/presupuestos/historial` |
| **CLIENTES** (rose / `pi pi-users`) | Clientes → `/clientes` · Historial de Atenciones → `/historial` |
| **PRODUCTOS** (emerald / `pi pi-box`) | Productos → `/productos` |
| **HERRAMIENTAS** (teal / `pi pi-wrench`) | Imprimir QR → `/etiquetas` · Calculadora → `/cotizador` · Historial de cotizaciones → `/cotizador/historial` |
| **CONFIGURACIÓN** (slate / `pi pi-cog`) | link directo → `/configuracion` (sin sub-ítems) |

Sub-ítems con su color/ícono (reusados del MoreMenu):
- Nuevo Pedido `pi pi-shopping-cart` sky · Historial de Pedidos `pi pi-receipt` sky
- Nuevo Presupuesto `pi pi-file-edit` amber · Historial de Presupuestos `pi pi-file` amber
- Clientes `pi pi-users` rose · Historial de Atenciones `pi pi-history` indigo
- Productos `pi pi-box` emerald
- Imprimir QR `pi pi-qrcode`/`pi pi-tags` violet · Calculadora `pi pi-calculator` teal · Historial de cotizaciones `pi pi-file-o` teal
- Configuración `pi pi-cog` slate

### Decisiones cerradas
- **"Imprimir QR" = el impresor de etiquetas QR (`/etiquetas`)**, ubicado bajo
  **HERRAMIENTAS**. No hay item QR del visor en el menú.
- **Los botones "Nuevo Cliente" (sesión) y "QR" (visor) se quedan en sus toolbars**
  de showroom y presupuestos sin cambios. El menú global NO incluye un "Nuevo
  Cliente": el alta del maestro se hace desde el botón propio de la página
  `/clientes` (evita un tercer concepto de "Nuevo Cliente").
- **Botón "Volver"** de `presupuestos-page.html:30-32` → eliminado.

### Riesgos / notas
- Foco del scan en showroom (memoria `feedback_focus_scan_showroom`): el menú navega
  fuera de la página al elegir un ítem, así que no hay retorno de foco que manejar;
  el caso de abrir/cerrar el dropdown sin elegir tiene la misma semántica que el
  `MoreMenu` popup actual (sin regresión).
- Espacio en el toolbar: el `p-menubar` con 6 categorías agrega ancho en el `#end`
  de los toolbars cargados (showroom, presupuestos). El colapso responsive de
  `p-menubar` mitiga en pantallas chicas; en desktop conviven con las acciones de
  página. Validar visualmente; si queda apretado, evaluar mover el menubar antes del
  bloque de acciones de página o usar el modo colapsado.
- `presupuestos-page.html` y `showroom-page.html` tienen cambios sin commitear
  (git status del inicio): no tocar esos cambios previos al editar.

## Alcance explícitamente excluido (YAGNI)
- No se rediseñan los toolbars completos de cada página; solo se reemplaza el
  componente de navegación (`MoreMenu` → `MainMenu`) y se quita "Volver".
- No se agregan permisos/roles por categoría del menú.
- No se cambia la lógica de sesión/visor ni los botones context-específicos.
