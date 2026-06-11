export interface ScanResult {
  sku: string;
  descripcion: string | null;
  /** Rubro DUX (ej. "MAQUINAS INDUSTRIALES"). Se usa para excluir ese rubro de
   *  los descuentos generales por escala — tanto en el showroom (al escanear)
   *  como en el PDF de productos no comprados. Null = rubro desconocido. */
  rubro: string | null;
  pvpKtGastroConIva: number | null;
  pvpKtGastroSinIva: number | null;
  porcIva: number | null;
  stockTotal: number | null;
  habilitado: boolean | null;
  imagenUrl: string | null;
  sincronizadoAt: string | null;
}

/** Nombre del rubro DUX que está excluido de los descuentos generales por
 *  escala. La comparación se hace case-insensitive y trimeada para tolerar
 *  variaciones de casing en DUX. Mantener sincronizado con la lista
 *  {@code RUBROS_SIN_DESCUENTO_ESCALA} del backend
 *  ({@code PresupuestoComercialPdfGenerator}). */
export const RUBROS_SIN_DESCUENTO_ESCALA = new Set(['MAQUINAS INDUSTRIALES']);

/** True si el rubro está excluido de los descuentos generales por escala.
 *  Tolera null/whitespace/casing/diacríticos — DUX a veces devuelve
 *  "Máquinas Industriales" con tilde o lowercase, lo aceptamos igual. */
export function rubroExcluyeDescuentos(rubro: string | null | undefined): boolean {
  const n = normalizarRubro(rubro);
  return n !== '' && RUBROS_SIN_DESCUENTO_ESCALA.has(n);
}

/** Normaliza un rubro para comparaciones robustas: trim, sin acentos, mayúsculas.
 *  DUX a veces devuelve el mismo rubro con tilde o lowercase; esto los unifica.
 *  Devuelve cadena vacía para null/whitespace. */
export function normalizarRubro(rubro: string | null | undefined): string {
  if (!rubro) return '';
  return rubro.trim()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toUpperCase();
}

export interface CarritoItem extends ScanResult {
  /** Identificador único del ítem dentro del carrito del operador. Para items
   *  normales coincide con el SKU; para productos genéricos (SKU comodín de
   *  DUX) es un uid sintético generado en el backend al crear el ítem. El
   *  frontend lo usa en las URLs PATCH/DELETE del carrito. */
  itemKey: string;
  cantidad: number;
  /** Descripción libre del producto genérico, igual a {@link ScanResult.descripcion}.
   *  Se envía como {@code comentarios} de la línea al payload DUX. Null en items
   *  normales del catálogo. */
  comentarios?: string | null;
  /** True si la línea representa un producto cargado a mano con el SKU
   *  comodín. El frontend lo usa para render distinto en la grilla y
   *  ocultar las acciones que solo aplican al catálogo (refresh, etc.). */
  generico?: boolean;
}

export interface RefreshStockRequest {
  skus: string[];
}

/** Payload del dialog "+ Producto genérico" para agregar una línea de SKU
 *  comodín al carrito. El backend resuelve el SKU desde {@code dux.sku-producto-generico}
 *  y genera un uid sintético como identificador del ítem. */
export interface CarritoAgregarGenericoRequest {
  descripcion: string;
  precioConIva: number;
  porcIva: number;
  cantidad: number;
  /** Si true, el backend setea {@code rubro=MAQUINAS INDUSTRIALES} en la
   *  línea para que quede excluida del descuento por escala (igual que las
   *  máquinas del catálogo). Default false. */
  maquinaria?: boolean;
}

export type CategoriaFiscal =
  | 'CONSUMIDOR_FINAL'
  | 'RESPONSABLE_INSCRIPTO'
  | 'EXENTO'
  | 'MONOTRIBUTISTA';

export type TipoDoc = 'DNI' | 'CUIT' | 'CUIL';

export interface CrearPedidoRequest {
  /** Razón social → DUX `apellido_razon_social` (obligatorio) + ficha de cliente. */
  apellidoRazonSocial: string;
  /** Nombre del cliente — OPCIONAL. NO se sube a DUX; solo se guarda en la ficha
   *  del cliente (columna nombre). */
  nombre?: string;
  categoriaFiscal?: CategoriaFiscal;
  tipoDoc?: TipoDoc;
  nroDoc?: number;
  codigoCliente?: string;
  /** Teléfono del cliente — obligatorio desde mayo 2026. Es el identificador
   *  único en la vista unificada de clientes (/clientes). */
  telefono: string;
  /** Email del cliente — sigue siendo obligatorio para crear pedidos (en
   *  presupuestos sí es opcional). El PDF de seguimiento post-pedido lo usa. */
  email: string;
  /** Rubro comercial del cliente — obligatorio desde mayo 2026. Igual a los
   *  rubros de presupuestos: 'bar' / 'restaurant' / 'catering' / 'cafeteria'
   *  / 'panaderia' / 'pasteleria' o texto libre cuando el operador elige
   *  "Otros". Se guarda en pedido_showroom.rubro. */
  rubro: string;
  domicilio?: string;
  codigoProvincia?: string;
  idLocalidad?: string;
  referencia?: string;
  observaciones?: string;
  /** Forma de pago elegida en el carrito. Si está, el backend aplica el
   *  recargo % de esa forma a cada precioUnitario antes de mandar a DUX. */
  formaPagoId?: number | null;
  /** True cuando el pedido se crea transformando un presupuesto comercial
   *  (dialog de /presupuestos), no desde el carrito del showroom. El backend
   *  usa este flag para NO asociar el pedido a la sesión de atención activa
   *  del operador (el presupuestador no abre sesión). Ausente/false en el
   *  flujo normal de showroom. */
  origenPresupuesto?: boolean;
  items: {
    sku: string;
    cantidad: number;
    /** Rubro DUX del producto — el backend lo usa para resolver el perfil
     *  (Normal/Maquinaria) de la forma de pago. */
    rubro?: string | null;
    /** Precio de lista unitario CON IVA (BRUTO). Base sobre la que el backend
     *  aplica el recargo/descuento de la forma de pago elegida. Para pedidos de
     *  presupuesto es el PVP congelado; para showroom, el del carrito. */
    precioUnitario: number | null;
    descuentoPorcentaje?: number | null;
    /** % de IVA del producto. Solo se considera para ítems genéricos (SKU
     *  comodín de DUX): el cache del SKU 9999990 no tiene un IVA
     *  representativo del producto real, así que el operador lo elige en el
     *  dialog. Para ítems normales el backend usa el porcIva del cache. */
    porcIva?: number | null;
    /** Texto libre que viaja al campo {@code comentarios} de la línea en el
     *  payload DUX. Usado principalmente con el SKU comodín para describir el
     *  producto real que no está en catálogo. */
    comentarios?: string | null;
  }[];
}

export interface CrearPedidoResponse {
  pedidoLocalId: number;
  estado: 'ENVIADO' | 'PENDIENTE' | 'ERROR';
  enviadoAt: string | null;
  mensaje: string;
}

export interface BackendError {
  message: string;
  path: string;
}

export interface Health {
  /** Epoch ms cuando arrancó el backend. Cambia en cada reinicio — el frontend
   *  lo compara contra el último visto para detectar reinicio y limpiar el
   *  estado in-memory (carrito + sesión) que perdió el server. Opcional para
   *  ser tolerante con fallbacks de error del cliente que sintetizan un Health. */
  bootTimeMs?: number;
  duxConfigurado: boolean;
  syncEnCurso: boolean;
  listaPrecios: string;
  totalProductos?: number;
  /** Solo presente si hay un sync corriendo. */
  syncIniciadoAt?: string;
  /** Fin de la última sync global exitosa (no incluye refreshes individuales). */
  ultimaSincronizacionAt?: string;
  /** SKU comodín de DUX para productos cargados a mano (sin catálogo). El
   *  frontend lo usa para identificar items genéricos en el carrito/presupuesto
   *  y para el dialog "+ Producto genérico". Opcional para tolerar backends
   *  viejos que aún no lo exponen — en ese caso el botón queda oculto. */
  skuProductoGenerico?: string;
}

export type SyncEventEstado =
  | 'STARTED'
  | 'PROGRESS'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'FAILED'
  | 'RATE_LIMITED';

export interface SyncEvent {
  estado: SyncEventEstado;
  iniciadoAt: string;
  items?: number;
  total?: number;
  esperandoMs?: number;
  intento?: number;
  mensaje?: string;
}

/** Sesión de atención al cliente. Una sesión agrupa todos los scans entre
 *  que el operador clickea "Nuevo cliente" y cierra el pedido. Hay una
 *  sola activa a la vez POR OPERADOR (cada uno trabaja en su propio canal;
 *  iniciar una nueva sesión solo cierra la del mismo operador, no la de
 *  los demás). Cuando no hay activa, los campos son null y `cantidadEscaneados=0`. */
export interface SesionShowroom {
  id: number | null;
  nombre: string | null;
  iniciadaAt: string | null;
  finalizadaAt: string | null;
  pedidoId: number | null;
  cantidadEscaneados: number;
}

export interface SesionScanItem {
  id: number;
  sku: string;
  descripcion: string | null;
  /** Rubro DUX al momento del scan — snapshot. */
  rubro: string | null;
  precioConIva: number | null;
  porcIva: number | null;
  imagenUrl: string | null;
  escaneadoAt: string;
  /** True si el SKU terminó incluido en el pedido asociado a la sesión.
   *  Solo significativo cuando la sesión tiene pedidoId — en abandonadas
   *  siempre es false. */
  compradoEnPedido: boolean;
}

export interface SesionDetalle {
  id: number;
  nombre: string;
  iniciadaAt: string;
  finalizadaAt: string | null;
  pedidoId: number | null;
  items: SesionScanItem[];
}

export interface SesionListItem {
  id: number;
  nombre: string;
  iniciadaAt: string;
  finalizadaAt: string | null;
  pedidoId: number | null;
  /** Estado del pedido asociado (null si no hay pedido). Permite distinguir
   *  COMPLETADA pero luego ANULADA del flujo normal completado. */
  estadoPedido: EstadoPedido | null;
  cantidadEscaneados: number;
  /** Nombre o username del operador que atendió la sesión. Null para
   *  sesiones legacy anteriores al multi-usuario. */
  creadoPor: string | null;
}

export interface SesionListPage {
  items: SesionListItem[];
  total: number;
  page: number;
  size: number;
}

export interface ListarSesionesParams {
  q?: string;
  desde?: string;
  hasta?: string;
  page?: number;
  size?: number;
  sortField?: string;
  sortOrder?: 'asc' | 'desc';
}

/** {@code AMBIGUO}: Gmail aceptó el adjunto pero el {@code 250 OK} no llegó
 *  antes de que la conexión se cortara. El mail muy probablemente se entregó —
 *  el operador debería verificar la bandeja del cliente antes de reintentar. */
export type PickingEmailEstado = 'SENT' | 'FAILED' | 'SKIPPED' | 'AMBIGUO';

export interface PickingEmailEvent {
  estado: PickingEmailEstado;
  /** Presente si el envío salió de un pedido OK o del botón ✉️ en /pedidos. */
  pedidoId?: number | null;
  /** Presente si el envío salió del botón ✉️ en /historial para sesiones
   *  abandonadas (sin pedido). Exclusivo con pedidoId. */
  sesionId?: number | null;
  cuit?: string | null;
  /** Destinatario al que se intentó/efectivamente despachó el mail. Se usa en
   *  el toast para identificar al cliente de un vistazo. */
  email?: string | null;
  error?: string | null;
}

export type WhatsappBusinessEstado = 'SENT' | 'FAILED' | 'WINDOW_CLOSED' | 'SKIPPED';

/** Resultado del envío del PDF por WhatsApp (Meta Cloud API). El estado
 *  {@code WINDOW_CLOSED} indica que el cliente no escribió en las últimas
 *  24hs — el operador debería pedirle un mensaje rápido y reintentar. */
export interface WhatsappBusinessEvent {
  estado: WhatsappBusinessEstado;
  /** Presente si el envío salió de un pedido OK o del botón WhatsApp en /pedidos. */
  pedidoId?: number | null;
  /** Presente si el envío salió del botón WhatsApp en /historial para sesiones
   *  abandonadas (sin pedido). Exclusivo con pedidoId. */
  sesionId?: number | null;
  /** Número normalizado al que se intentó mandar (solo dígitos, internacional). */
  telefono?: string | null;
  error?: string | null;
}

/** Configuración de la integración con el programa externo pickit-y-etiquetas
 *  (jar Java desktop en el host, ejecutado por el backend vía ProcessBuilder).
 *  Los paths son del CONTAINER Docker, no del host — el host mapea via volúmenes. */
export interface PickitConfig {
  enabled: boolean;
  jarPath: string;
  stockFile: string;
  combosFile: string;
  outputDir: string;
  /** Path del host mapeado al volumen `/app/pickit` (read-only — lo provee el
   *  backend desde la env `SHOWROOM_PICKIT_HOST_PATH` del docker-compose).
   *  Cadena vacía si la integración no está montada. */
  hostPath?: string;
}

/** SSE emitido tras intentar generar el pickit externo (auto post-DUX o manual). */
export interface PickitExternoEvent {
  estado: 'GENERATED' | 'FAILED';
  pedidoId: number;
  outputPath: string | null;
  error: string | null;
  /** ID de la pestaña/PC que originó el pedido (header X-Client-Id). Solo esa
   *  PC auto-descarga el .xlsx; las demás muestran únicamente el toast. Null
   *  si la request no incluyó el header (clientes viejos). */
  clientId: string | null;
}

/** Notificación al visor cuando el operador escanea un código que no existe
 *  ni en cache local ni en DUX. El visor muestra un mensaje en lugar del
 *  último producto válido, para evitar que el cliente confunda el código
 *  fallido con el producto que tenía en pantalla. */
export interface ScanVisorError {
  codigo: string;
}

/** Forma de pago elegida por el operador en el scan, reemitida al visor para
 *  que la pantalla del cliente muestre el precio con esa misma forma. El visor
 *  mantiene el último `formaId` recibido (sticky). */
export interface VisorFormaEvent {
  formaId: number;
}

/** Una línea del presupuesto tal como la ve el cliente en el visor read-only. */
export interface PresupuestoVisorItem {
  sku: string;
  descripcion: string | null;
  imagenUrl: string | null;
  cantidad: number;
  /** Precio de referencia unitario (forma destacada según el rubro del ítem). */
  precioUnitario: number;
  /** % de descuento individual de la línea (0 = sin descuento). */
  descuentoPorcentaje: number;
  /** `precioUnitario * (1 - descuento) * cantidad`. */
  subtotalLinea: number;
}

/** Una forma de pago con su precio final calculado, para el visor de presupuesto. */
export interface PresupuestoVisorFormaPago {
  id: number | null;
  nombre: string;
  precioFinal: number;
  /** Cuotas de la forma (para el desglose "N cuotas de $X"); 1/null = contado. */
  cantidadCuotas: number | null;
  /** True para la forma más barata (resaltada en el visor). */
  esMejorPrecio: boolean;
}

/** Snapshot del armado de un presupuesto para el visor read-only del celular
 *  (pantalla `/visor-presupuesto/{username}`). Lo arma `presupuestos-page` ante
 *  cada cambio y lo publica vía `POST /visor/presupuesto`; el backend lo guarda
 *  en memoria y lo reemite por SSE (`presupuesto-visor`). `clienteNombre`
 *  null/vacío ⇒ el visor muestra el encabezado genérico "Presupuesto". */
export interface PresupuestoVisor {
  clienteNombre: string | null;
  items: PresupuestoVisorItem[];
  total: number;
  formasPago: PresupuestoVisorFormaPago[];
}

/** Origen del cambio en el carrito — el frontend usa esto para mostrar toast
 *  diferenciado cuando un cliente desde /visor agrega algo. */
export type CarritoOrigen = 'OPERADOR' | 'VISOR' | 'SISTEMA';

/** Estado completo del carrito server-side. Payload del SSE `carrito-updated`
 *  y respuesta de todos los endpoints mutadores. */
export interface CarritoState {
  items: CarritoItem[];
  origen: CarritoOrigen;
}

/** Respuesta del POST a agregar al carrito (operador o visor). Incluye cuánto
 *  se agregó realmente (puede ser menor a `cantidadPedida` si quedó al tope). */
export interface CarritoAgregarResponse {
  carrito: CarritoState;
  cantidadPedida: number;
  cantidadAgregada: number;
  recortado: boolean;
  motivo: string | null;
}

export interface CatalogoItem {
  sku: string;
  descripcion: string | null;
  /** Rubro DUX — para excluir el producto de los descuentos generales al
   *  agregarlo al carrito desde la lista de resultados de búsqueda. */
  rubro: string | null;
  pvpKtGastroSinIva: number | null;
  /** PVP gastro CON IVA y % de IVA — necesarios para calcular los precios de
   *  referencia (Efectivo/Transferencia/…) en los resultados de búsqueda. */
  pvpKtGastroConIva: number | null;
  porcIva: number | null;
  habilitado: boolean | null;
  /** URL del endpoint local de imagen, o null si no existe el archivo. */
  imagenUrl: string | null;
  /** Stock total sumado de todos los depósitos. Null si nunca se sincronizó. */
  stockTotal: number | null;
  /** Nombre del proveedor en DUX. Null si no informado. */
  proveedor?: string | null;
}

export interface CatalogoPage {
  items: CatalogoItem[];
  total: number;
  page: number;
  size: number;
}

export interface EtiquetaSeleccionada extends CatalogoItem {
  /** Identificador único interno — necesario porque ahora puede haber varias
   *  entradas con el mismo SKU pero distintos `numeroOrden` (flujo Excel). */
  uid: string;
  copias: number;
  /** Número de orden/pedido del cliente — se imprime en la etiqueta. Presente
   *  solo cuando la entrada vino del flujo de importación de Excel. */
  numeroOrden: string | null;
}

export interface ProductoListItem {
  sku: string;
  descripcion: string | null;
  rubro: string | null;
  /** Nombre del proveedor en DUX. Null si no informado. */
  proveedor?: string | null;
  pvpKtGastroConIva: number | null;
  pvpKtGastroSinIva: number | null;
  porcIva: number | null;
  stockTotal: number | null;
  habilitado: boolean | null;
  imagenUrl: string | null;
  codigosBarra: string[];
  sincronizadoAt: string | null;
}

export interface ProductoListPage {
  items: ProductoListItem[];
  total: number;
  page: number;
  size: number;
}

export interface ListarProductosParams {
  q?: string;
  soloDeshabilitados?: boolean;
  soloSinStock?: boolean;
  /** Filtro por rubro DUX exacto (ej. "MAQUINAS INDUSTRIALES"). El backend
   *  matchea case-insensitive. Null/undefined = sin filtro. */
  rubro?: string | null;
  /** Filtro por proveedor exacto (nombre DUX). Null/undefined = sin filtro. */
  proveedor?: string | null;
  page?: number;
  size?: number;
  sortField?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface Provincia {
  codigo: string;
  nombre: string;
}

export interface Localidad {
  id: string;
  nombre: string;
  codigoProvincia: string;
}

export type EstadoPedido = 'PENDIENTE' | 'ENVIADO' | 'ERROR' | 'ANULADO';

/** Toggles de envío automático del PDF tras pedido OK. NO afectan los botones
 *  manuales en /pedidos ni /historial — esos siguen disponibles siempre. */
export interface NotificacionesAutoConfig {
  emailAutoPedido: boolean;
  whatsappAutoPedido: boolean;
}

/** Cuerpo del mensaje (caption) que se manda junto al PDF por WhatsApp.
 *  Editable desde /configuracion. `personalizado=false` indica que todavía no
 *  hay mensaje configurado (mensaje viene vacío) — el PDF se va a mandar sin
 *  caption hasta que el operador cargue uno. */
export interface WhatsappMensajeConfig {
  mensaje: string;
  personalizado: boolean;
}

/** URL base con la que el frontend arma el QR del visor (ej.
 *  `http://192.168.1.50:4200`). Necesaria cuando el operador entra a la app por
 *  hostname/DNS que los celulares no resuelven. Vacío → el QR cae a
 *  `window.location.origin`. */
export interface VisorConfig {
  baseUrl: string;
}

/** Punto de un ranking de productos del historial (top escaneados / top comprados). */
export interface EstadisticaProducto {
  sku: string;
  descripcion: string | null;
  total: number;
}

/** KPI global del showroom: cuántas sesiones cerradas terminaron en pedido
 *  (no anulado). El frontend muestra {@code sesionesConPedido / sesionesFinalizadas}
 *  como un % grande. */
export interface TasaConversionGlobal {
  sesionesFinalizadas: number;
  sesionesConPedido: number;
}

/** Tasa de conversión real de un producto: porcentaje de sesiones que lo
 *  escanearon y terminaron comprándolo. Identifica ganchos (alta conversión)
 *  vs vidriera (mucho mirado, poca venta). Siempre entre 0 y 100. */
export interface ConversionProducto {
  sku: string;
  descripcion: string | null;
  /** Sesiones únicas que escanearon el SKU (re-scans en la misma sesión
   *  cuentan una sola vez — sino el denominador se infla). */
  sesionesEscaneadas: number;
  /** Sesiones que escanearon Y terminaron en pedido no anulado con el SKU. */
  sesionesConCompra: number;
  porcentaje: number;
}

/** Snapshot agregado para los charts y KPIs del historial. */
export interface EstadisticasHistorial {
  topEscaneados: EstadisticaProducto[];
  topComprados: EstadisticaProducto[];
  tasaConversion: TasaConversionGlobal;
  topConversion: ConversionProducto[];
}

/** Perfil de impresión de etiquetas (geometría + tipografía + toggles).
 *  Compartido entre todas las PCs del showroom — el "perfil activo" lo elige
 *  cada PC localmente (localStorage), no viene en este modelo. El {@code config}
 *  es opaco al backend; el shape vive en el componente. */
export interface PerfilEtiquetas {
  /** null al crear, presente al editar / leer del backend. */
  id: number | null;
  nombre: string;
  config: Record<string, unknown>;
  /** ISO timestamp; null al crear desde el form. */
  creadoAt: string | null;
  actualizadoAt: string | null;
}

/** Forma de pago configurable desde /configuracion. El operador la elige en
 *  el carrito; el recargo % se aplica al total y se snapshotea en el pedido. */
export interface FormaPago {
  id: number;
  nombre: string;
  recargoPorcentaje: number;
  cantidadCuotas: number;
  /** Si la forma agrega IVA al precio que paga el cliente. Default true.
   *  Cuando es false (ej: "transferencia sin IVA"), el operador absorbe el
   *  IVA — DUX igual factura con IVA pero el cliente paga sin. */
  aplicaIva: boolean;
  /** Recargo % del perfil "maquinaria" (rubros de maquinaria). Null = usa
   *  `recargoPorcentaje`. */
  recargoPorcentajeMaquinaria: number | null;
  /** Aplica IVA del perfil "maquinaria". Null = false (sin IVA). */
  aplicaIvaMaquinaria: boolean | null;
  activo: boolean;
  orden: number;
  /** Si la forma se muestra como precio de referencia (perfil menaje) en
   *  scan/visor/carrito. El `orden` define cuál es la primera/destacada.
   *  Default false. */
  precioReferencia: boolean;
  /** Si la forma se muestra como precio de referencia para el perfil
   *  maquinaria. Default false. */
  precioReferenciaMaquinaria: boolean;
  /** ISO timestamp; null al crear desde el form. */
  creadoAt: string | null;
}

export interface PedidoListItem {
  id: number;
  creadoAt: string;
  enviadoAt: string | null;
  /** Cuándo se anuló (si aplica). Null si el pedido no fue anulado. */
  anuladoAt: string | null;
  estado: EstadoPedido;
  nroDoc: number | null;
  /** Placeholder fijo "PEDIDO SHOWROOM" que va a DUX como `apellido_razon_social`.
   *  No es el nombre real del cliente — eso vive en `nombre`. */
  apellidoRazonSocial: string | null;
  /** Nombre y apellido (o razón social) real del cliente. Es lo que se muestra
   *  en la columna Cliente del listado. Null si el operador no lo cargó. */
  nombre: string | null;
  /** Email del cliente. Si está vacío, el botón "Reenviar email" se oculta. */
  email: string | null;
  /** Teléfono del cliente. Si está vacío, el botón "Enviar por WhatsApp" se oculta. */
  telefono: string | null;
  /** Total que pagó el cliente. Tiene IVA si la forma de pago aplica IVA (caso
   *  normal); está sin IVA si la forma no lo aplica. Ver detalle del pedido para
   *  saber cuál es el caso. */
  total: number | null;
  /** Total sin IVA del pedido (recargo aplicado). Coincide con {@code total}
   *  cuando la forma de pago no aplica IVA. */
  totalSinIva: number | null;
  descuentoPorcentaje: number | null;
  /** Snapshot del nombre de la forma de pago. Null si no se eligió. */
  formaPagoNombre: string | null;
  /** Snapshot del flag aplicaIva de la forma. Null si no hubo forma. */
  formaPagoAplicaIva: boolean | null;
  /** Snapshot de la cantidad de cuotas. Null si no hubo forma. */
  cantidadCuotas: number | null;
  cantidadItems: number;
  /** Nombre o username del operador que creó el pedido. Null para pedidos
   *  legacy anteriores al multi-usuario. */
  creadoPor: string | null;
  /** Id del presupuesto que originó este pedido (presupuesto convertido).
   *  Null si el pedido nació en el showroom. */
  presupuestoId?: number | null;
  /** Id de la sesión de showroom que originó este pedido. Null si el pedido
   *  vino de un presupuesto. */
  sesionId?: number | null;
}

export interface PedidoListPage {
  items: PedidoListItem[];
  total: number;
  page: number;
  size: number;
}

export interface PedidoItemDetalle {
  sku: string;
  descripcion: string | null;
  cantidad: number;
  /** Precio unitario CON IVA. */
  precioUnitario: number | null;
  /** % de IVA aplicado al producto al momento del pedido. */
  porcIva: number | null;
  /** Si el {@code precioUnitario} de este ítem lleva IVA, según el perfil
   *  (menaje/maquinaria) del rubro. Null en pedidos anteriores a esta columna
   *  → se cae al flag global {@code formaPagoAplicaIva} del pedido. */
  aplicaIva: boolean | null;
  /** % de descuento de la línea. El {@code precioUnitario} es BRUTO; el subtotal
   *  neto se deriva como precio × cant × (1 − desc/100). Null/0 = sin descuento. */
  descuentoPorcentaje: number | null;
  /** URL del endpoint local de imagen del producto, o null si no existe el archivo. */
  imagenUrl: string | null;
  /** Comentarios libres de la línea (se envió a DUX como {@code comentarios}).
   *  Trae la descripción tipeada por el operador para items genéricos; null
   *  en items normales del catálogo. */
  comentarios?: string | null;
}

export interface PedidoDetalle {
  id: number;
  creadoAt: string;
  enviadoAt: string | null;
  /** Cuándo se anuló (si aplica). Null si el pedido no fue anulado. */
  anuladoAt: string | null;
  /** Motivo libre que el operador tipeó al anular. Null/blank si no se especificó. */
  motivoAnulacion: string | null;
  estado: EstadoPedido;
  respuestaDux: string | null;
  nroDoc: number | null;
  tipoDoc: string | null;
  /** Placeholder fijo "PEDIDO SHOWROOM" que va a DUX como `apellido_razon_social`. */
  apellidoRazonSocial: string | null;
  /** Nombre y apellido (o razón social) real del cliente. Null si no se cargó. */
  nombre: string | null;
  telefono: string | null;
  email: string | null;
  domicilio: string | null;
  codigoProvincia: string | null;
  provinciaNombre: string | null;
  idLocalidad: string | null;
  localidadNombre: string | null;
  /** Total que pagó el cliente (incluye recargo si hubo financiación). Tiene
   *  IVA si {@code formaPagoAplicaIva} es true/null (caso normal); está sin IVA
   *  si la forma no aplica IVA — DUX igual recibió el comprobante con IVA pero
   *  el operador absorbió la diferencia. */
  total: number | null;
  /** Total sin IVA del pedido (recargo aplicado). Coincide con {@code total}
   *  cuando {@code formaPagoAplicaIva===false}. */
  totalSinIva: number | null;
  descuentoPorcentaje: number | null;
  /** Forma de pago elegida (FK). Null si no se eligió. */
  formaPagoId: number | null;
  /** Snapshot del nombre de la forma de pago — sobrevive al borrado/edición. */
  formaPagoNombre: string | null;
  /** % de recargo aplicado. Null si no hubo. */
  recargoPorcentaje: number | null;
  /** Cantidad de cuotas — informativo. */
  cantidadCuotas: number | null;
  /** Snapshot del flag aplicaIva de la forma. Null si no hubo forma de pago.
   *  Cuando es false, el cliente pagó precio sin IVA y el operador absorbió
   *  la diferencia (DUX recibió igual el comprobante con IVA). */
  formaPagoAplicaIva: boolean | null;
  /** Total CON IVA antes del recargo financiero. Null si no hubo recargo. */
  totalSinRecargo: number | null;
  observaciones: string | null;
  items: PedidoItemDetalle[];
}

/**
 * Escalón de descuento por subtotal del carrito (sin IVA). Cuando el subtotal
 * iguala o supera `umbralMin`, se aplica `porcentaje` al carrito completo.
 * El frontend lee la lista al iniciar y elige el escalón con mayor `umbralMin`
 * cuyo umbral fue alcanzado.
 */
export interface EscalaDescuento {
  umbralMin: number;
  porcentaje: number;
}

/**
 * Horario diario al que disparar la sincronización automática con DUX.
 * Se interpreta en zona America/Argentina/Buenos_Aires.
 */
export interface HorarioSync {
  hora: number;
  minuto: number;
}

// =====================================================
// Presupuesto comercial (pantalla /presupuestos)
// =====================================================

/** Ítem de un presupuesto comercial — el operador lo arma en la pantalla
 *  escaneando productos y eligiendo cantidad + descuento individual.
 *  Estado UI puro: vive en signals del componente, no se persiste hasta que
 *  se genera el PDF. */
export interface PresupuestoItem extends ScanResult {
  /** Identificador único interno — permite reordenar / borrar sin chocar SKUs duplicados. */
  uid: string;
  cantidad: number;
  /** % de descuento individual aplicado al ítem (0..100). */
  descuentoPorcentaje: number;
  /** True cuando el ítem fue cargado a mano con el SKU comodín. La grilla lo
   *  marca con un badge "Genérico" y el render usa la descripción que tipeó el
   *  operador (que también se guarda en {@link comentarios}). */
  generico?: boolean;
  /** Texto libre que viaja a DUX como {@code comentarios} de la línea cuando
   *  el presupuesto se transforma en pedido. Para genéricos = descripción
   *  tipeada por el operador. Null en items normales del catálogo. */
  comentarios?: string | null;
}

/** Snapshot de una forma de pago precalculada en el frontend. Se manda al
 *  backend tal cual para que el PDF muestre el precio final sin doble cálculo. */
export interface PresupuestoFormaPagoSnapshot {
  id: number | null;
  nombre: string;
  recargoPorcentaje: number | null;
  cantidadCuotas: number | null;
  aplicaIva: boolean | null;
  precioFinal: number;
  descripcion?: string | null;
  monedaSimbolo?: string | null;
  /** SKU del ítem al que corresponde el snapshot en modo cotización individual.
   *  Null cuando la forma es global (sumando todos los ítems). */
  itemSku?: string | null;
  /** Perfil "maquinaria" de la forma (recargo/IVA propios para rubros sin IVA).
   *  El backend los usa para recalcular el precio por ítem según el rubro al
   *  generar el PDF, igual que el carrito mixto del showroom. */
  recargoPorcentajeMaquinaria?: number | null;
  aplicaIvaMaquinaria?: boolean | null;
}

/** Payload del POST /presupuesto-comercial/preview y /enviar (campo `presupuesto`). */
export interface GenerarPresupuestoRequest {
  clienteNombre?: string | null;
  clienteTelefono?: string | null;
  clienteEmail?: string | null;
  /** Rubro comercial del cliente — string libre. El frontend muestra un
   *  dropdown con opciones predefinidas y un input para "Otros". */
  rubro?: string | null;
  observaciones?: string | null;
  /** % de descuento sobre el subtotal (0..100). Se aplica al final, después
   *  de los descuentos individuales por ítem. */
  descuentoGlobalPorcentaje?: number;
  /** Si true, el PDF genera UNA hoja por ítem (foto + formas de pago
   *  calculadas sobre el precio del ítem). Si false/undefined, el PDF
   *  produce el formato agregado tradicional (tabla detalle + total +
   *  formas globales). */
  cotizacionIndividual?: boolean;
  items: {
    sku: string;
    descripcion?: string | null;
    /** Rubro DUX — para que el PDF de "ítems de interés" pueda decidir si
     *  muestra o no las columnas de descuento por escala para este ítem. */
    rubro?: string | null;
    cantidad: number;
    precioConIva: number;
    porcIva?: number | null;
    descuentoPorcentaje?: number | null;
    /** Precio unitario con la forma de pago de REFERENCIA (la marcada "Precio
     *  ref.", por defecto Efectivo), ya según rubro (c/IVA menaje, s/IVA
     *  maquinaria). Es lo que se muestra como "precio del producto" y la base de
     *  los totales. Null en presupuestos viejos. El backend acepta el nombre
     *  viejo `precioEfectivo` vía alias al leer los JSON persistidos. */
    precioReferencia?: number | null;
    /** True si `precioReferencia` es un valor CON IVA (menaje), false si es
     *  SIN IVA (maquinaria). Congela el perfil de IVA con que se cotizó el
     *  ítem para que el pedido lo facture igual sin re-deducirlo. */
    precioReferenciaConIva?: boolean;
    /** Texto libre que viaja como {@code comentarios} a DUX cuando el
     *  presupuesto se transforma en pedido. Usado para productos genéricos. */
    comentarios?: string | null;
  }[];
  formasPago: PresupuestoFormaPagoSnapshot[];
}

export interface EnviarPresupuestoRequest {
  email: string;
  presupuesto: GenerarPresupuestoRequest;
}

/** Ítem del listado de presupuestos guardados (pantalla /presupuestos/historial). */
export interface PresupuestoListItem {
  id: number;
  creadoAt: string;
  /** Última edición del presupuesto. Null si no se editó desde que se generó —
   *  el historial muestra un pill "Editado" cuando hay valor. */
  modificadoAt: string | null;
  clienteNombre: string | null;
  clienteTelefono: string | null;
  clienteEmail: string | null;
  rubro: string | null;
  totalSinIva: number | null;
  descuentoGlobalPorcentaje: number | null;
  /** Nombre o username del operador que generó el presupuesto. Null para
   *  presupuestos legacy anteriores al multi-usuario. */
  creadoPor: string | null;
  /** Id del pedido DUX si el operador transformó el presupuesto en pedido.
   *  Null = pendiente. El historial muestra pill "→ Pedido #N" cuando aplica. */
  convertidoEnPedidoId: number | null;
  /** Cuándo se (re)generó el pedido. Null si nunca se convirtió. Si el
   *  presupuesto se editó después (modificadoAt > convertidoAt), se ofrece
   *  "Regenerar pedido". */
  convertidoAt?: string | null;
}

/** Snapshot completo de un presupuesto persistido — el frontend lo consume
 *  desde {@code GET /presupuesto-comercial/{id}/detalle} para reconstruir el
 *  estado de la pantalla en modo edición. Los items y formas se rehidratan
 *  del JSON persistido. */
export interface PresupuestoDetalle {
  id: number;
  creadoAt: string;
  modificadoAt: string | null;
  clienteNombre: string | null;
  clienteTelefono: string | null;
  clienteEmail: string | null;
  rubro: string | null;
  observaciones: string | null;
  descuentoGlobalPorcentaje: number | null;
  cotizacionIndividual: boolean | null;
  /** Id del pedido DUX si este presupuesto ya fue convertido. Opcional para
   *  tolerar respuestas de backends anteriores que todavía no exponen el
   *  campo — en ese caso el frontend lo trata como `null` (no convertido).
   *  La pantalla de edición lo usa para mostrar el pill "→ Pedido #N" en
   *  lugar del botón "Crear pedido" y evitar la doble conversión. */
  convertidoEnPedidoId?: number | null;
  /** Cuándo se (re)generó el pedido. Null si nunca se convirtió. Si el
   *  presupuesto se editó después (modificadoAt > convertidoAt) se habilita
   *  "Regenerar pedido". */
  convertidoAt?: string | null;
  items: {
    sku: string;
    descripcion: string | null;
    rubro?: string | null;
    cantidad: number;
    precioConIva: number;
    porcIva: number | null;
    descuentoPorcentaje: number | null;
    /** Precio unitario con la forma de pago de referencia, ya según rubro.
     *  Lo usa la pantalla de presupuesto (display/edición/PDF). Null en
     *  presupuestos viejos persistidos antes de este campo — al editar, el
     *  frontend lo recalcula y no rompe si viene ausente. */
    precioReferencia?: number | null;
    /** True si `precioReferencia` es CON IVA (menaje), false si SIN IVA
     *  (maquinaria). Congela el perfil con que se cotizó el ítem en el
     *  presupuesto. Null en presupuestos viejos. */
    precioReferenciaConIva?: boolean;
    /** Comentarios libres persistidos junto al item — para items genéricos
     *  trae la descripción tipeada por el operador. Null en items normales. */
    comentarios?: string | null;
  }[];
  formasPago: PresupuestoFormaPagoSnapshot[];
}

export interface PresupuestoListPage {
  items: PresupuestoListItem[];
  total: number;
  page: number;
  size: number;
}

export interface ListarPresupuestosParams {
  id?: number;
  q?: string;
  desde?: string;
  hasta?: string;
  page?: number;
  size?: number;
  sortField?: string;
  sortOrder?: 'asc' | 'desc';
}

/** Resumen de cliente agrupado (pantalla /clientes). Construido en el
 *  backend a partir de presupuestos NO eliminados + pedidos (incluyendo
 *  anulados — el contador es histórico). Agrupado por teléfono normalizado:
 *  movimientos sin teléfono no aparecen. */
export interface ClientePresupuestos {
  email: string | null;
  telefono: string | null;
  nombre: string | null;
  /** Razón social / apellido (del maestro editable). Null si no se cargó. */
  razonSocial: string | null;
  rubro: string | null;
  /** Cantidad de presupuestos comerciales generados (0 si solo tiene pedidos). */
  cantidadPresupuestos: number;
  /** Cantidad de pedidos (incluye anulados; 0 si solo tiene presupuestos). */
  cantidadPedidos: number;
  /** Fecha del movimiento más antiguo (presupuesto o pedido). */
  primerMovimientoAt: string;
  /** Fecha del movimiento más reciente — define los datos canónicos
   *  (nombre/email/rubro) y el orden de la tabla. */
  ultimoMovimientoAt: string;
  ultimoTotalSinIva: number | null;
  /** ID del último presupuesto — null si solo tiene pedidos. */
  ultimoPresupuestoId: number | null;
  /** ID del último pedido — null si solo tiene presupuestos. */
  ultimoPedidoId: number | null;
  // ---- Datos de facturación y envío (del último pedido; null si el cliente
  //      solo tiene presupuestos). El master, si los tiene, los pisa. ----
  tipoDoc: string | null;
  nroDoc: number | null;
  domicilio: string | null;
  /** Código (cod_iso) de la provincia — clave para editar/pre-seleccionar. */
  codigoProvincia: string | null;
  /** Nombre de la provincia resuelto en el backend — para mostrar/ordenar. */
  provinciaNombre: string | null;
  idLocalidad: string | null;
  localidadNombre: string | null;
}

/** Payload del PUT /cliente-master — upsert del maestro editable de clientes.
 *  El teléfono es la clave lógica (se normaliza a solo dígitos en el backend);
 *  el resto de los campos pueden venir null/vacíos: el master los persiste
 *  como null y el listado de /clientes cae al valor del último movimiento. */
export interface ActualizarClienteRequest {
  telefono: string;
  razonSocial: string | null;
  nombre: string | null;
  email: string | null;
  rubro: string | null;
  notas: string | null;
  // ---- Datos de facturación y envío (opcionales) ----
  tipoDoc: string | null;
  nroDoc: number | null;
  domicilio: string | null;
  codigoProvincia: string | null;
  idLocalidad: string | null;
}

/** Datos de un cliente para autocompletar el pedido al tipear el CUIT. Lo
 *  resuelve el backend desde el maestro de clientes o el último pedido con ese
 *  documento. Todos los campos son opcionales — el front completa solo lo vacío. */
export interface ClienteAutocompletar {
  razonSocial: string | null;
  nombre: string | null;
  email: string | null;
  telefono: string | null;
  rubro: string | null;
  tipoDoc: string | null;
  nroDoc: number | null;
  domicilio: string | null;
  codigoProvincia: string | null;
  idLocalidad: string | null;
}

export type PresupuestoEmailEstado = 'SENT' | 'FAILED' | 'AMBIGUO';

export interface PresupuestoEmailEvent {
  estado: PresupuestoEmailEstado;
  presupuestoId: number;
  email: string;
  error?: string | null;
}

// =====================================================
// Cotización financiera (pantalla /cotizador)
//
// Variante "rápida" del presupuesto: sin productos, solo un monto base
// (con IVA) y la lista de formas de pago calculadas. Para responder
// "¿cuánto sale $X en cuotas?".
// =====================================================

/** Payload del POST /cotizacion-financiera/preview y /enviar. */
export interface GenerarCotizacionRequest {
  clienteNombre?: string | null;
  clienteTelefono?: string | null;
  clienteEmail?: string | null;
  rubro?: string | null;
  observaciones?: string | null;
  /** Monto base CON IVA principal (el operador lo carga con IVA, igual que en
   *  scan/presupuesto). Puede ser 0 si la cotización usa SOLO el segundo
   *  monto — el backend valida que al menos uno de los dos sea > 0. */
  montoBaseConIva: number;
  /** % de IVA del monto principal — default 21 si null. */
  porcIva?: number | null;
  /** Segundo monto base CON IVA, opcional. Permite cotizar dos productos con
   *  tasas de IVA distintas (ej. 21% + 10.5%) en una sola cotización. Las
   *  formas de pago se calculan sobre la suma respetando cada IVA. Null o 0
   *  = no se usa el segundo monto. */
  montoBaseConIva2?: number | null;
  /** % de IVA del segundo monto — default 10.5 si null y hay monto2 > 0. */
  porcIva2?: number | null;
  formasPago: PresupuestoFormaPagoSnapshot[];
}

export interface EnviarCotizacionRequest {
  email: string;
  cotizacion: GenerarCotizacionRequest;
}

/** Ítem del listado del historial /cotizador/historial. */
export interface CotizacionListItem {
  id: number;
  creadoAt: string;
  modificadoAt: string | null;
  clienteNombre: string | null;
  clienteTelefono: string | null;
  clienteEmail: string | null;
  rubro: string | null;
  montoBaseConIva: number | null;
  creadoPor: string | null;
}

export interface CotizacionListPage {
  items: CotizacionListItem[];
  total: number;
  page: number;
  size: number;
}

export interface ListarCotizacionesParams {
  id?: number;
  q?: string;
  desde?: string;
  hasta?: string;
  page?: number;
  size?: number;
  sortField?: string;
  sortOrder?: 'asc' | 'desc';
}

/** Snapshot completo de una cotización persistida. Para pre-llenar la
 *  pantalla /cotizador/editar/:id. */
export interface CotizacionDetalle {
  id: number;
  creadoAt: string;
  modificadoAt: string | null;
  clienteNombre: string | null;
  clienteTelefono: string | null;
  clienteEmail: string | null;
  rubro: string | null;
  observaciones: string | null;
  montoBaseConIva: number;
  porcIva: number | null;
  montoBaseConIva2?: number | null;
  porcIva2?: number | null;
  formasPago: PresupuestoFormaPagoSnapshot[];
}

export type CotizacionEmailEstado = 'SENT' | 'FAILED' | 'AMBIGUO';

export interface CotizacionEmailEvent {
  estado: CotizacionEmailEstado;
  cotizacionId: number;
  email: string;
  error?: string | null;
}

export interface ListarPedidosParams {
  /** Si viene, la lista colapsa a ese pedido — usado por el deep-link desde
   *  /historial para llevar al usuario directo al pedido clickeado. */
  id?: number;
  q?: string;
  estado?: EstadoPedido;
  desde?: string;
  hasta?: string;
  page?: number;
  size?: number;
  /** Campo por el que ordenar (whitelisted en el backend). */
  sortField?: string;
  /** 'asc' o 'desc' (default 'desc'). */
  sortOrder?: 'asc' | 'desc';
}
