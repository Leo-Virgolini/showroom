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
  stockStale: boolean;
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
  nombre?: string;
  categoriaFiscal?: CategoriaFiscal;
  tipoDoc?: TipoDoc;
  nroDoc?: number;
  codigoCliente?: string;
  telefono?: string;
  email?: string;
  domicilio?: string;
  codigoProvincia?: string;
  idLocalidad?: string;
  referencia?: string;
  observaciones?: string;
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
 *  que el operador clickea "Nuevo cliente" y cierra el pedido. Hay una sola
 *  activa a la vez (global, como el carrito). Cuando no hay activa, los
 *  campos son null y `cantidadEscaneados=0`. */
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

export type PickingEmailEstado = 'SENT' | 'FAILED';

export interface PickingEmailEvent {
  estado: PickingEmailEstado;
  pedidoId: number;
  cuit?: string | null;
  /** Destinatario al que se intentó/efectivamente despachó el mail. Se usa en
   *  el toast para identificar al cliente de un vistazo. */
  email?: string | null;
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
  /** Total CON IVA — lo que va a DUX en el comprobante. */
  total: number | null;
  /** Total SIN IVA — lo que efectivamente paga el cliente. */
  totalSinIva: number | null;
  descuentoPorcentaje: number | null;
  cantidadItems: number;
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
  /** Total CON IVA — lo que va a DUX. */
  total: number | null;
  /** Total SIN IVA — lo que paga el cliente. */
  totalSinIva: number | null;
  descuentoPorcentaje: number | null;
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
