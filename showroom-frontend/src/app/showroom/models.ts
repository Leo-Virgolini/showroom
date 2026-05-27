export interface ScanResult {
  sku: string;
  descripcion: string | null;
  pvpKtGastroConIva: number | null;
  pvpKtGastroSinIva: number | null;
  porcIva: number | null;
  stockTotal: number | null;
  habilitado: boolean | null;
  imagenUrl: string | null;
  sincronizadoAt: string | null;
}

export interface CarritoItem extends ScanResult {
  cantidad: number;
}

export interface RefreshStockRequest {
  skus: string[];
}

export type CategoriaFiscal =
  | 'CONSUMIDOR_FINAL'
  | 'RESPONSABLE_INSCRIPTO'
  | 'EXENTO'
  | 'MONOTRIBUTISTA';

export type TipoDoc = 'DNI' | 'CUIT' | 'CUIL';

export interface CrearPedidoRequest {
  apellidoRazonSocial: string;
  /** Nombre del cliente — obligatorio desde mayo 2026 (antes opcional). */
  nombre: string;
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
  items: {
    sku: string;
    cantidad: number;
    precioUnitario: number | null;
    descuentoPorcentaje?: number | null;
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
  pvpKtGastroSinIva: number | null;
  habilitado: boolean | null;
  /** URL del endpoint local de imagen, o null si no existe el archivo. */
  imagenUrl: string | null;
  /** Stock total sumado de todos los depósitos. Null si nunca se sincronizó. */
  stockTotal: number | null;
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
  activo: boolean;
  orden: number;
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
  /** URL del endpoint local de imagen del producto, o null si no existe el archivo. */
  imagenUrl: string | null;
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
    cantidad: number;
    precioConIva: number;
    porcIva?: number | null;
    descuentoPorcentaje?: number | null;
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
  clienteNombre: string | null;
  clienteTelefono: string | null;
  clienteEmail: string | null;
  rubro: string | null;
  totalSinIva: number | null;
  descuentoGlobalPorcentaje: number | null;
  /** Nombre o username del operador que generó el presupuesto. Null para
   *  presupuestos legacy anteriores al multi-usuario. */
  creadoPor: string | null;
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
}

/** Resumen de cliente agrupado (pantalla /clientes). Construido en el
 *  backend a partir de presupuestos NO eliminados + pedidos (incluyendo
 *  anulados — el contador es histórico). Agrupado por teléfono normalizado:
 *  movimientos sin teléfono no aparecen. */
export interface ClientePresupuestos {
  email: string | null;
  telefono: string | null;
  nombre: string | null;
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
}

/** Payload del PUT /cliente-master — upsert del maestro editable de clientes.
 *  El teléfono es la clave lógica (se normaliza a solo dígitos en el backend);
 *  el resto de los campos pueden venir null/vacíos: el master los persiste
 *  como null y el listado de /clientes cae al valor del último movimiento. */
export interface ActualizarClienteRequest {
  telefono: string;
  nombre: string | null;
  email: string | null;
  rubro: string | null;
  notas: string | null;
}

export type PresupuestoEmailEstado = 'SENT' | 'FAILED' | 'AMBIGUO';

export interface PresupuestoEmailEvent {
  estado: PresupuestoEmailEstado;
  presupuestoId: number;
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
