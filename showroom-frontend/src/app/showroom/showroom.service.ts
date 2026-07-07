import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams, HttpResponse } from '@angular/common/http';
import { Observable, map, of, catchError } from 'rxjs';
import {
  ActualizarClienteRequest,
  ClienteAutocompletar,
  CarritoAgregarGenericoRequest,
  CarritoAgregarResponse,
  CarritoState,
  CatalogoItem,
  CatalogoPage,
  ClientePresupuestos,
  ClientesPage,
  ListarClientesParams,
  CrearPedidoRequest,
  CrearPedidoResponse,
  EnviarPresupuestoRequest,
  EscalaDescuento,
  EstadisticasHistorial,
  FormaPago,
  GenerarPresupuestoRequest,
  Health,
  ListarPresupuestosParams,
  NotificacionesAutoConfig,
  HorarioSync,
  ListarPedidosParams,
  ListarProductosParams,
  ListarSesionesParams,
  Localidad,
  PedidoDetalle,
  PedidoListPage,
  PerfilEtiquetas,
  PickitConfig,
  EnviarCotizacionRequest,
  GenerarCotizacionRequest,
  PresupuestoDetalle,
  PresupuestoListPage,
  PresupuestoVisor,
  ProductoListPage,
  Provincia,
  RefreshStockRequest,
  ScanResult,
  SesionDetalle,
  SesionListPage,
  SesionShowroom,
  VisorConfig,
  WhatsappMensajeConfig,
} from './models';

@Injectable({ providedIn: 'root' })
export class ShowroomService {
  private readonly http = inject(HttpClient);
  private readonly base = '/api/showroom';

  /** Lookup por SKU. Con {@code publicarVisor=false} el backend NO emite el
   *  evento SSE `scan-visor` ni registra el scan en la sesión activa — útil
   *  para flujos paralelos como /presupuestos donde el producto no debe
   *  aparecer en la pantalla del cliente. */
  scan(sku: string, publicarVisor = true): Observable<ScanResult> {
    let params = new HttpParams();
    if (!publicarVisor) params = params.set('publicarVisor', 'false');
    return this.http.get<ScanResult>(`${this.base}/scan/${encodeURIComponent(sku)}`, { params });
  }

  /** Llamada desde /visor/:username cuando el cliente toca "Agregar al carrito"
   *  en el celular. El backend lo suma al carrito DEL OPERADOR identificado
   *  por {@code username} y emite SSE `carrito-updated` en su canal personal.
   *  La respuesta incluye cuánto se sumó realmente. */
  visorAgregarAlCarrito(username: string, sku: string, cantidad: number, forzar = false):
      Observable<CarritoAgregarResponse> {
    return this.http.post<CarritoAgregarResponse>(
      `${this.base}/visor/${encodeURIComponent(username)}/agregar-carrito`,
      { sku, cantidad, forzar });
  }

  /** Publica al visor del operador autenticado la forma de pago elegida en el
   *  scan. El backend resuelve el operador por la sesión/token (igual que el
   *  scan) y emite SSE `visor-forma` { formaId } en su canal personal, para que
   *  la pantalla del cliente muestre el precio con esa misma forma. */
  publicarFormaVisor(formaId: number): Observable<void> {
    return this.http.post<void>(`${this.base}/visor/forma`, { formaId });
  }

  /** Estado de la sesión activa de un operador específico — endpoint público
   *  que usa el visor para mostrar el nombre del cliente actual. */
  visorObtenerSesionActiva(username: string): Observable<SesionShowroom> {
    return this.http.get<SesionShowroom>(
      `${this.base}/visor/${encodeURIComponent(username)}/sesion/activa`);
  }

  /** Publica al visor de presupuesto del operador autenticado el snapshot
   *  actual del armado (ítems + total + formas de pago). El backend lo guarda
   *  en memoria y emite SSE `presupuesto-visor` en su canal personal. Lo
   *  dispara `presupuestos-page` ante cada cambio (con debounce). */
  publicarPresupuestoVisor(snapshot: PresupuestoVisor): Observable<void> {
    return this.http.post<void>(`${this.base}/visor/presupuesto`, snapshot);
  }

  /** Snapshot actual del armado del presupuesto de un operador — endpoint
   *  público para la hidratación inicial del visor cuando el celular abre el
   *  QR. Devuelve un snapshot vacío si el operador todavía no publicó nada. */
  visorObtenerPresupuesto(username: string): Observable<PresupuestoVisor> {
    return this.http.get<PresupuestoVisor>(
      `${this.base}/visor/${encodeURIComponent(username)}/presupuesto`);
  }

  // =====================================================
  // Carrito server-side (autenticado). El estado vive en el backend; las
  // pantallas se sincronizan via SSE carrito-updated.
  // =====================================================

  obtenerCarrito(): Observable<CarritoState> {
    return this.http.get<CarritoState>(`${this.base}/carrito`);
  }

  agregarItemCarrito(sku: string, cantidad: number, forzar = false): Observable<CarritoAgregarResponse> {
    return this.http.post<CarritoAgregarResponse>(
      `${this.base}/carrito/items`, { sku, cantidad, forzar });
  }

  /** Agrega una línea de producto genérico (SKU comodín de DUX) al carrito.
   *  El backend genera un uid sintético como itemKey para que varias líneas
   *  con el mismo SKU comodín coexistan, cada una con su descripción y precio. */
  agregarGenericoCarrito(req: CarritoAgregarGenericoRequest): Observable<CarritoState> {
    return this.http.post<CarritoState>(`${this.base}/carrito/generico`, req);
  }

  /** {@code itemKey} es la clave única dentro del carrito: SKU para items
   *  normales, uid sintético para genéricos. Coincide con {@link CarritoItem.itemKey}. */
  actualizarCantidadItemCarrito(itemKey: string, cantidad: number): Observable<CarritoState> {
    return this.http.patch<CarritoState>(
      `${this.base}/carrito/items/${encodeURIComponent(itemKey)}`, { cantidad });
  }

  eliminarItemCarrito(itemKey: string): Observable<CarritoState> {
    return this.http.delete<CarritoState>(
      `${this.base}/carrito/items/${encodeURIComponent(itemKey)}`);
  }

  vaciarCarritoServer(): Observable<CarritoState> {
    return this.http.delete<CarritoState>(`${this.base}/carrito`);
  }

  refrescarStockCarritoServer(): Observable<CarritoState> {
    return this.http.post<CarritoState>(`${this.base}/carrito/refresh-stock`, {});
  }

  refreshStock(skus: string[]): Observable<ScanResult[]> {
    const body: RefreshStockRequest = { skus };
    return this.http.post<ScanResult[]>(`${this.base}/refresh-stock`, body);
  }

  crearPedido(request: CrearPedidoRequest): Observable<CrearPedidoResponse> {
    return this.http.post<CrearPedidoResponse>(`${this.base}/pedido-dux`, request);
  }

  /** Busca los datos de un cliente por CUIT para autocompletar el pedido.
   *  Devuelve null si no hay coincidencias (el backend responde 404) o ante
   *  cualquier error — es best-effort, nunca bloquea la carga del pedido. */
  buscarClientePorCuit(nroDoc: number): Observable<ClienteAutocompletar | null> {
    return this.http.get<ClienteAutocompletar>(`${this.base}/cliente-master/por-cuit/${nroDoc}`)
      .pipe(catchError(() => of(null)));
  }

  /** Busca el cliente que YA tiene ese teléfono (para el aviso "teléfono ya
   *  registrado"). null si no hay ninguno. Best-effort. */
  buscarClientePorTelefono(telefono: string): Observable<ClienteAutocompletar | null> {
    return this.http.get<ClienteAutocompletar>(`${this.base}/cliente-master/por-telefono/${encodeURIComponent(telefono)}`)
      .pipe(catchError(() => of(null)));
  }

  /** Busca clientes guardados por razón social / nombre (autocompletado del
   *  pedido). Best-effort: ante error devuelve lista vacía. */
  buscarClientesPorRazonSocial(q: string): Observable<ClienteAutocompletar[]> {
    const params = new HttpParams().set('q', q);
    return this.http.get<ClienteAutocompletar[]>(`${this.base}/cliente-master/buscar`, { params })
      .pipe(catchError(() => of([])));
  }

  /** Regenera el pedido de un presupuesto editado: crea uno nuevo en DUX con
   *  `request`, anula el anterior (local) y re-vincula el presupuesto. El
   *  backend hace todo en una operación; no hay que llamar a
   *  `marcarPresupuestoConvertido` aparte. */
  regenerarPedido(presupuestoId: number, request: CrearPedidoRequest): Observable<CrearPedidoResponse> {
    return this.http.post<CrearPedidoResponse>(
      `${this.base}/presupuesto-comercial/${presupuestoId}/regenerar-pedido`, request);
  }

  /** Edita un pedido: crea uno nuevo en DUX con los datos editados y anula el viejo
   *  (endpoint de Fase 1). Mismo body que `/pedido-dux`. */
  regenerarPedidoDesdePedido(pedidoId: number, request: CrearPedidoRequest): Observable<CrearPedidoResponse> {
    return this.http.post<CrearPedidoResponse>(`${this.base}/pedidos/${pedidoId}/regenerar`, request);
  }

  syncCatalogo(force = false): Observable<{ message: string }> {
    let params = new HttpParams();
    if (force) params = params.set('force', 'true');
    return this.http.post<{ message: string }>(`${this.base}/sync-catalogo`, {}, { params });
  }

  cancelarSync(): Observable<{ message: string }> {
    return this.http.post<{ message: string }>(`${this.base}/sync-catalogo/cancelar`, {});
  }

  buscarCatalogo(
    q: string,
    page = 0,
    size = 50,
    sortField?: 'descripcion' | 'precio',
    sortOrder?: 'asc' | 'desc',
    proveedor?: string | null,
  ): Observable<CatalogoPage> {
    let params = new HttpParams().set('page', page).set('size', size);
    if (q && q.trim()) params = params.set('q', q.trim());
    // Orden elegido por el operador (producto/precio). Si no se manda, el
    // backend ordena por relevancia (comportamiento por defecto).
    if (sortField) params = params.set('sortField', sortField);
    if (sortOrder) params = params.set('sortOrder', sortOrder);
    // Filtro por proveedor (nombre exacto). Vacío = sin filtro.
    if (proveedor && proveedor.trim()) params = params.set('proveedor', proveedor.trim());
    return this.http.get<CatalogoPage>(`${this.base}/catalogo`, { params });
  }

  /** Proveedores para el dropdown del filtro. Si se pasa `q`, devuelve solo los
   *  proveedores de los productos que matchean esa búsqueda. */
  listarProveedoresCatalogo(q?: string): Observable<string[]> {
    let params = new HttpParams();
    if (q && q.trim()) params = params.set('q', q.trim());
    return this.http.get<string[]>(`${this.base}/catalogo/proveedores`, { params });
  }

  lookupBulk(skus: string[]): Observable<CatalogoItem[]> {
    return this.http.post<CatalogoItem[]>(`${this.base}/lookup`, { skus });
  }

  listarProductos(opts: ListarProductosParams = {}): Observable<ProductoListPage> {
    let params = new HttpParams()
      .set('page', opts.page ?? 0)
      .set('size', opts.size ?? 50);
    if (opts.q && opts.q.trim()) params = params.set('q', opts.q.trim());
    if (opts.soloDeshabilitados) params = params.set('soloDeshabilitados', 'true');
    if (opts.soloSinStock) params = params.set('soloSinStock', 'true');
    if (opts.rubro && opts.rubro.trim()) params = params.set('rubro', opts.rubro.trim());
    if (opts.proveedor && opts.proveedor.trim()) params = params.set('proveedor', opts.proveedor.trim());
    if (opts.sortField) params = params.set('sortField', opts.sortField);
    if (opts.sortOrder) params = params.set('sortOrder', opts.sortOrder);
    return this.http.get<ProductoListPage>(`${this.base}/productos`, { params });
  }

  /** Rubros distintos del catálogo cacheado — para el dropdown del filtro
   *  por rubro en la pantalla {@code /productos}. */
  listarRubrosProductos(): Observable<string[]> {
    return this.http.get<string[]>(`${this.base}/productos/rubros`);
  }

  health(): Observable<Health> {
    return this.http.get<Health>(`${this.base}/health`);
  }

  /** Escalones de descuento configurados (umbral subtotal s/IVA → % a aplicar). */
  obtenerEscalasDescuento(): Observable<EscalaDescuento[]> {
    return this.http.get<EscalaDescuento[]>(`${this.base}/config/escalas-descuento`);
  }

  /** Reemplaza atómicamente la lista de escalones. Devuelve la lista actualizada. */
  actualizarEscalasDescuento(escalas: EscalaDescuento[]): Observable<EscalaDescuento[]> {
    return this.http.put<EscalaDescuento[]>(`${this.base}/config/escalas-descuento`, escalas);
  }

  // =====================================================
  // Formas de pago — CRUD para /configuracion + listado activas para /showroom-page.
  // El recargo % se aplica al carrito completo y se snapshotea en el pedido.
  // =====================================================

  /** Toggle global de sync automática con DUX. {@code false} pausa los
   *  disparos de los horarios programados sin borrarlos. */
  obtenerSyncAuto(): Observable<{ habilitada: boolean }> {
    return this.http.get<{ habilitada: boolean }>(`${this.base}/config/sync-auto`);
  }

  guardarSyncAuto(habilitada: boolean): Observable<{ habilitada: boolean }> {
    return this.http.put<{ habilitada: boolean }>(`${this.base}/config/sync-auto`, { habilitada });
  }

  /** Listado completo (activas + inactivas) — para /configuracion. */
  listarFormasPagoConfig(): Observable<FormaPago[]> {
    return this.http.get<FormaPago[]>(`${this.base}/config/formas-pago`);
  }

  /** Listado activas — para el selector del operador en el carrito. */
  listarFormasPagoActivas(): Observable<FormaPago[]> {
    return this.http.get<FormaPago[]>(`${this.base}/formas-pago/activas`);
  }

  crearFormaPago(forma: Partial<FormaPago>): Observable<FormaPago> {
    return this.http.post<FormaPago>(`${this.base}/config/formas-pago`, forma);
  }

  actualizarFormaPago(id: number, forma: Partial<FormaPago>): Observable<FormaPago> {
    return this.http.put<FormaPago>(`${this.base}/config/formas-pago/${id}`, forma);
  }

  /** Soft delete — marca la forma como inactiva. Sobrevive en pedidos viejos. */
  eliminarFormaPago(id: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/config/formas-pago/${id}`);
  }

  /** Borrado definitivo (hard delete). Los pedidos históricos no se afectan
   *  (snapshotean nombre + recargo). */
  eliminarFormaPagoDefinitivo(id: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/config/formas-pago/${id}/definitivo`);
  }

  // ===========================================================
  // Perfiles de etiquetas — compartidos entre PCs.
  // El "perfil activo" lo elige cada PC localmente (localStorage).
  // ===========================================================

  listarPerfilesEtiquetas(): Observable<PerfilEtiquetas[]> {
    return this.http.get<PerfilEtiquetas[]>(`${this.base}/config/perfiles-etiquetas`);
  }

  crearPerfilEtiquetas(perfil: Partial<PerfilEtiquetas>): Observable<PerfilEtiquetas> {
    return this.http.post<PerfilEtiquetas>(`${this.base}/config/perfiles-etiquetas`, perfil);
  }

  actualizarPerfilEtiquetas(id: number, perfil: Partial<PerfilEtiquetas>): Observable<PerfilEtiquetas> {
    return this.http.put<PerfilEtiquetas>(`${this.base}/config/perfiles-etiquetas/${id}`, perfil);
  }

  eliminarPerfilEtiquetas(id: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/config/perfiles-etiquetas/${id}`);
  }

  /** Horarios diarios de sincronización automática con DUX (zona AR). */
  obtenerHorariosSync(): Observable<HorarioSync[]> {
    return this.http.get<HorarioSync[]>(`${this.base}/config/horarios-sync`);
  }

  /** Reemplaza atómicamente la lista de horarios. El backend reprograma los disparos en el momento. */
  actualizarHorariosSync(horarios: HorarioSync[]): Observable<HorarioSync[]> {
    return this.http.put<HorarioSync[]>(`${this.base}/config/horarios-sync`, horarios);
  }

  /** Config de la integración con el programa pickit-y-etiquetas. */
  obtenerPickitConfig(): Observable<PickitConfig> {
    return this.http.get<PickitConfig>(`${this.base}/config/pickit`);
  }

  actualizarPickitConfig(cfg: PickitConfig): Observable<PickitConfig> {
    return this.http.put<PickitConfig>(`${this.base}/config/pickit`, cfg);
  }

  /** Toggles de envío automático del PDF tras pedido (email + whatsapp).
   *  No afectan los botones manuales — esos siguen funcionando siempre. */
  obtenerNotificacionesAuto(): Observable<NotificacionesAutoConfig> {
    return this.http.get<NotificacionesAutoConfig>(`${this.base}/config/notificaciones-auto`);
  }

  guardarNotificacionesAuto(cfg: NotificacionesAutoConfig): Observable<NotificacionesAutoConfig> {
    return this.http.put<NotificacionesAutoConfig>(`${this.base}/config/notificaciones-auto`, cfg);
  }

  /** Cuerpo del mensaje (caption) del PDF en WhatsApp. Soporta {nombre} y el
   *  formato nativo de WhatsApp (*negrita*, _itálica_, ~tachado~, `mono`).
   *  `personalizado=false` significa que no hay mensaje configurado todavía —
   *  el PDF se mandará sin caption hasta que se cargue uno desde /configuracion. */
  obtenerWhatsappMensaje(): Observable<WhatsappMensajeConfig> {
    return this.http.get<WhatsappMensajeConfig>(`${this.base}/config/whatsapp-mensaje`);
  }

  /** Guarda el mensaje. Pasar `mensaje: ''` borra la fila — el PDF se va a
   *  mandar sin caption hasta que el operador configure uno nuevo. */
  guardarWhatsappMensaje(cfg: WhatsappMensajeConfig): Observable<WhatsappMensajeConfig> {
    return this.http.put<WhatsappMensajeConfig>(`${this.base}/config/whatsapp-mensaje`, cfg);
  }

  /** URL base para el QR del visor (ej. http://192.168.1.50:4200). Necesaria
   *  cuando el operador entra por hostname/DNS que los celulares no resuelven.
   *  `baseUrl` vacío → el QR cae a `window.location.origin`. */
  obtenerVisorConfig(): Observable<VisorConfig> {
    return this.http.get<VisorConfig>(`${this.base}/config/visor`);
  }

  /** Guarda la URL base. Pasar `baseUrl: ''` borra la fila — el QR vuelve a
   *  heredar el origin del navegador. */
  guardarVisorConfig(cfg: VisorConfig): Observable<VisorConfig> {
    return this.http.put<VisorConfig>(`${this.base}/config/visor`, cfg);
  }

  /** Rubros cuyos productos cotizan SIN IVA (precio base = PVP sin IVA). Endpoint
   *  público: lo consume también el visor sin autenticar. */
  obtenerRubrosSinIva(): Observable<string[]> {
    return this.http
      .get<{ rubros: string[] }>(`${this.base}/config/rubros-sin-iva`)
      .pipe(map((r) => r.rubros ?? []));
  }

  /** Guarda la lista de rubros sin IVA. Lista vacía → vuelve al default
   *  (MAQUINAS INDUSTRIALES). */
  guardarRubrosSinIva(rubros: string[]): Observable<string[]> {
    return this.http
      .put<{ rubros: string[] }>(`${this.base}/config/rubros-sin-iva`, { rubros })
      .pipe(map((r) => r.rubros ?? []));
  }

  /** Regenera el pickit externo manualmente para un pedido ya existente. El
   *  resultado llega vía SSE pickit-externo (toast). */
  regenerarPickitExterno(id: number): Observable<{ message: string; pedidoId: number }> {
    return this.http.post<{ message: string; pedidoId: number }>(
      `${this.base}/pedidos/${id}/pickit-externo`, {});
  }

  /** Genera el pickit externo desde el carrito actual, al abrir el diálogo de
   *  pedido (antes de que exista un pedido). El resultado llega vía SSE
   *  pickit-externo (toast + auto-descarga en la PC origen). */
  generarPickitDesdeCarrito(): Observable<{ message: string }> {
    return this.http.post<{ message: string }>(`${this.base}/carrito/pickit-externo`, {});
  }

  /** Descarga el .xlsx pickit generado por el programa externo. El `path` lo
   *  provee el SSE `pickit-externo` con estado GENERATED. El backend valida
   *  que esté dentro del outputDir configurado (anti path-traversal). */
  descargarPickitExternoArchivo(path: string): Observable<HttpResponse<Blob>> {
    const params = new HttpParams().set('path', path);
    return this.http.get(`${this.base}/pickit-externo/descargar`, {
      params,
      observe: 'response',
      responseType: 'blob',
    });
  }


  obtenerProvincias(): Observable<Provincia[]> {
    return this.http.get<Provincia[]>(`${this.base}/provincias`);
  }

  obtenerLocalidades(codigoProvincia: string): Observable<Localidad[]> {
    const params = new HttpParams().set('codigoProvincia', codigoProvincia);
    return this.http.get<Localidad[]>(`${this.base}/localidades`, { params });
  }

  listarPedidos(opts: ListarPedidosParams = {}): Observable<PedidoListPage> {
    let params = new HttpParams()
      .set('page', opts.page ?? 0)
      .set('size', opts.size ?? 50);
    if (opts.id != null) params = params.set('id', opts.id);
    if (opts.q && opts.q.trim()) params = params.set('q', opts.q.trim());
    if (opts.estado) params = params.set('estado', opts.estado);
    if (opts.desde) params = params.set('desde', opts.desde);
    if (opts.hasta) params = params.set('hasta', opts.hasta);
    if (opts.sortField) params = params.set('sortField', opts.sortField);
    if (opts.sortOrder) params = params.set('sortOrder', opts.sortOrder);
    return this.http.get<PedidoListPage>(`${this.base}/pedidos`, { params });
  }

  obtenerPedido(id: number): Observable<PedidoDetalle> {
    return this.http.get<PedidoDetalle>(`${this.base}/pedidos/${id}`);
  }

  /** Descarga el PDF de "productos vistos pero no comprados" de una sesión —
   *  para el botón del Historial. Sirve tanto para sesiones con pedido (vistos
   *  menos comprados) como abandonadas (todos los vistos). 404 si compró todo. */
  descargarPdfSesion(sesionId: number): Observable<HttpResponse<Blob>> {
    return this.http.get(`${this.base}/sesiones/${sesionId}/pdf`, {
      observe: 'response',
      responseType: 'blob',
    });
  }

  reenviarEmailPedido(id: number): Observable<{ message: string; pedidoId: number }> {
    return this.http.post<{ message: string; pedidoId: number }>(
      `${this.base}/pedidos/${id}/email`,
      {},
    );
  }

  reenviarWhatsappPedido(id: number): Observable<{ message: string; pedidoId: number }> {
    return this.http.post<{ message: string; pedidoId: number }>(
      `${this.base}/pedidos/${id}/whatsapp`,
      {},
    );
  }

  /** Envía el PDF de productos vistos por email — para sesiones del historial
   *  que terminaron SIN pedido. El operador carga el email destinatario. */
  enviarEmailSesion(sesionId: number, email: string): Observable<{ message: string; sesionId: number }> {
    return this.http.post<{ message: string; sesionId: number }>(
      `${this.base}/sesiones/${sesionId}/email`,
      { email },
    );
  }

  /** Envía el PDF de productos vistos por WhatsApp — para sesiones del
   *  historial que terminaron SIN pedido. El operador carga el teléfono. */
  enviarWhatsappSesion(sesionId: number, telefono: string): Observable<{ message: string; sesionId: number }> {
    return this.http.post<{ message: string; sesionId: number }>(
      `${this.base}/sesiones/${sesionId}/whatsapp`,
      { telefono },
    );
  }

  /** Anula un pedido. El backend marca estado=ANULADO, registra timestamp y
   *  motivo opcional. Devuelve el detalle ya actualizado. NO toca DUX —
   *  si el pedido había sido cargado allí, hay que cancelarlo manualmente. */
  anularPedido(id: number, motivo?: string | null): Observable<PedidoDetalle> {
    const body = motivo && motivo.trim() ? { motivo: motivo.trim() } : {};
    return this.http.post<PedidoDetalle>(`${this.base}/pedidos/${id}/anular`, body);
  }

  /** Revierte la anulación. El backend restaura el estado previo (ENVIADO /
   *  ERROR / PENDIENTE) en función de los timestamps preservados y limpia
   *  anuladoAt + motivoAnulacion. Devuelve el detalle actualizado. */
  reactivarPedido(id: number): Observable<PedidoDetalle> {
    return this.http.post<PedidoDetalle>(`${this.base}/pedidos/${id}/reactivar`, {});
  }

  // =====================================================
  // Sesión de atención (historial de scans por cliente)
  // =====================================================

  /** Inicia una nueva sesión con el nombre del cliente. Cierra la anterior
   *  si había una abierta. Devuelve el estado de la nueva sesión activa. */
  iniciarSesion(nombre: string): Observable<SesionShowroom> {
    return this.http.post<SesionShowroom>(`${this.base}/sesion/iniciar`, { nombre });
  }

  /** Cancela la sesión activa (cliente se fue sin comprar, operador descarta). */
  cancelarSesion(): Observable<SesionShowroom> {
    return this.http.post<SesionShowroom>(`${this.base}/sesion/cancelar`, {});
  }

  /** Estado actual de la sesión activa (o placeholder inactivo si no hay). */
  obtenerSesionActiva(): Observable<SesionShowroom> {
    return this.http.get<SesionShowroom>(`${this.base}/sesion/activa`);
  }

  listarSesiones(opts: ListarSesionesParams = {}): Observable<SesionListPage> {
    let params = new HttpParams()
      .set('page', opts.page ?? 0)
      .set('size', opts.size ?? 50);
    if (opts.q && opts.q.trim()) params = params.set('q', opts.q.trim());
    if (opts.desde) params = params.set('desde', opts.desde);
    if (opts.hasta) params = params.set('hasta', opts.hasta);
    if (opts.sortField) params = params.set('sortField', opts.sortField);
    if (opts.sortOrder) params = params.set('sortOrder', opts.sortOrder);
    return this.http.get<SesionListPage>(`${this.base}/sesiones`, { params });
  }

  obtenerSesion(id: number): Observable<SesionDetalle> {
    return this.http.get<SesionDetalle>(`${this.base}/sesiones/${id}`);
  }

  /** Estadísticas agregadas para los charts del historial (top escaneados / comprados). */
  obtenerEstadisticasHistorial(opts: { desde?: string; hasta?: string; topN?: number } = {}):
      Observable<EstadisticasHistorial> {
    let params = new HttpParams();
    if (opts.desde) params = params.set('desde', opts.desde);
    if (opts.hasta) params = params.set('hasta', opts.hasta);
    if (opts.topN != null) params = params.set('topN', opts.topN);
    return this.http.get<EstadisticasHistorial>(`${this.base}/historial/estadisticas`, { params });
  }

  // =====================================================
  // Presupuesto comercial — pantalla /presupuestos
  // =====================================================

  /** Genera el PDF de presupuesto y lo devuelve como blob. Persiste la
   *  cabecera en BD (asigna número) aunque el operador no envíe email. El
   *  header `X-Presupuesto-Id` viene con el número asignado. */
  previewPresupuestoComercial(req: GenerarPresupuestoRequest): Observable<HttpResponse<Blob>> {
    return this.http.post(`${this.base}/presupuesto-comercial/preview`, req, {
      observe: 'response',
      responseType: 'blob',
    });
  }

  /** Genera + persiste + envía el PDF al email del cliente (async — el toast
   *  llega vía SSE `presupuesto-comercial-email`). */
  enviarPresupuestoComercial(req: EnviarPresupuestoRequest):
      Observable<{ message: string; presupuestoId: number; email: string }> {
    return this.http.post<{ message: string; presupuestoId: number; email: string }>(
      `${this.base}/presupuesto-comercial/enviar`, req);
  }

  /** Listado paginado de presupuestos guardados con filtros opcionales. */
  listarPresupuestosComerciales(opts: ListarPresupuestosParams = {}): Observable<PresupuestoListPage> {
    let params = new HttpParams()
      .set('page', opts.page ?? 0)
      .set('size', opts.size ?? 50);
    if (opts.id != null) params = params.set('id', opts.id);
    if (opts.q && opts.q.trim()) params = params.set('q', opts.q.trim());
    if (opts.desde) params = params.set('desde', opts.desde);
    if (opts.hasta) params = params.set('hasta', opts.hasta);
    if (opts.sortField) params = params.set('sortField', opts.sortField);
    if (opts.sortOrder) params = params.set('sortOrder', opts.sortOrder);
    return this.http.get<PresupuestoListPage>(`${this.base}/presupuesto-comercial`, { params });
  }

  /** Listado paginado (server-side) de clientes — agrupados por teléfono
   *  normalizado. La actividad (contadores, último movimiento/total) está
   *  materializada en el backend, así que pagina y ordena en SQL. Filtro `q`
   *  por nombre/razón social/email/teléfono/CUIT. */
  listarClientesPresupuestos(opts: ListarClientesParams = {}): Observable<ClientesPage> {
    let params = new HttpParams()
      .set('page', opts.page ?? 0)
      .set('size', opts.size ?? 25);
    if (opts.q && opts.q.trim()) params = params.set('q', opts.q.trim());
    if (opts.sortField) params = params.set('sortField', opts.sortField);
    if (opts.sortOrder) params = params.set('sortOrder', opts.sortOrder);
    return this.http.get<ClientesPage>(`${this.base}/presupuesto-comercial/clientes`, { params });
  }

  /** Todos los clientes que matchean `q`, sin paginar — para el export CSV, que
   *  necesita el conjunto completo y no solo la página visible. */
  exportarClientesPresupuestos(q?: string): Observable<ClientePresupuestos[]> {
    let params = new HttpParams();
    if (q && q.trim()) params = params.set('q', q.trim());
    return this.http.get<ClientePresupuestos[]>(
      `${this.base}/presupuesto-comercial/clientes/export`, { params });
  }

  /** Upsert del maestro de clientes — guarda overrides editables de
   *  nombre/email/rubro/notas para el cliente identificado por el teléfono.
   *  No toca los presupuestos/pedidos históricos: el merge se hace al armar
   *  la vista de /clientes en el backend. */
  actualizarClienteMaster(payload: ActualizarClienteRequest): Observable<void> {
    return this.http.put<void>(`${this.base}/cliente-master`, payload);
  }

  /** Soft-delete del cliente: lo oculta del listado de /clientes pero deja
   *  intactos los presupuestos/pedidos históricos. Si el operador edita el
   *  cliente desde el dialog luego de borrarlo, queda reactivado. */
  eliminarClienteMaster(telefono: string): Observable<void> {
    return this.http.delete<void>(
      `${this.base}/cliente-master/${encodeURIComponent(telefono)}`);
  }

  /** Soft-delete masivo de clientes por lista de teléfonos. Devuelve cuántos se
   *  marcaron como eliminados. */
  eliminarClientesMasivo(telefonos: string[]): Observable<{ eliminados: number }> {
    return this.http.post<{ eliminados: number }>(
      `${this.base}/cliente-master/eliminar-masivo`, { telefonos });
  }

  /** Marca un presupuesto como transformado en pedido — el backend registra
   *  `convertidoEnPedidoId` y el historial muestra el pill "→ Pedido #N".
   *  Se llama después del POST a /pedido-dux con respuesta OK. */
  marcarPresupuestoConvertido(presupuestoId: number, pedidoId: number): Observable<void> {
    const params = new HttpParams().set('pedidoId', pedidoId);
    return this.http.put<void>(
      `${this.base}/presupuesto-comercial/${presupuestoId}/marcar-convertido`,
      {},
      { params },
    );
  }

  /** Elimina (soft-delete) un presupuesto del historial. El registro
   *  físicamente persiste en la DB con `eliminado_at` poblado, pero deja
   *  de aparecer en el listado del historial. */
  eliminarPresupuestoComercial(id: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/presupuesto-comercial/${id}`);
  }

  /** Snapshot completo de un presupuesto guardado — para pre-llenar la
   *  pantalla `/presupuestos/editar/:id`. */
  obtenerDetallePresupuestoComercial(id: number): Observable<PresupuestoDetalle> {
    return this.http.get<PresupuestoDetalle>(
      `${this.base}/presupuesto-comercial/${id}/detalle`);
  }

  /** Actualiza in-place un presupuesto existente. Devuelve el PDF
   *  regenerado (mismo shape que `previewPresupuestoComercial`). El backend
   *  conserva el id + `creadoAt` y setea `modificadoAt = now()`. */
  actualizarPresupuestoComercial(id: number, req: GenerarPresupuestoRequest):
      Observable<HttpResponse<Blob>> {
    return this.http.put(`${this.base}/presupuesto-comercial/${id}`, req, {
      observe: 'response',
      responseType: 'blob',
    });
  }

  /** Actualiza in-place + dispara el envío del email (async — el toast
   *  llega vía SSE `presupuesto-comercial-email`). */
  actualizarYEnviarPresupuestoComercial(id: number, req: EnviarPresupuestoRequest):
      Observable<{ message: string; presupuestoId: number; email: string }> {
    return this.http.put<{ message: string; presupuestoId: number; email: string }>(
      `${this.base}/presupuesto-comercial/${id}/enviar`, req);
  }

  /** Descarga el PDF de un presupuesto persistido (regenerado desde los
   *  JSON guardados al momento de la creación).
   *
   *  @param modo Fuerza el formato del PDF:
   *    - `'agregado'`: tabla + total + formas globales.
   *    - `'individual'`: una hoja por cada producto.
   *    - omitido: respeta el modo original con el que se generó. */
  descargarPdfPresupuestoComercial(
      id: number,
      modo?: 'agregado' | 'individual'): Observable<HttpResponse<Blob>> {
    let params = new HttpParams();
    if (modo) params = params.set('modo', modo);
    return this.http.get(`${this.base}/presupuesto-comercial/${id}/pdf`, {
      observe: 'response',
      responseType: 'blob',
      params,
    });
  }

  // =====================================================
  // Cotización financiera — pantalla /cotizador
  // =====================================================

  /** Genera el PDF de cotización al vuelo y devuelve el blob. Instantáneo:
   *  no persiste ni asigna número de cotización. */
  previewCotizacionFinanciera(req: GenerarCotizacionRequest): Observable<HttpResponse<Blob>> {
    return this.http.post(`${this.base}/cotizacion-financiera/preview`, req, {
      observe: 'response',
      responseType: 'blob',
    });
  }

  /** Genera + envía PDF por email (async — SSE
   *  `cotizacion-financiera-email`). */
  enviarCotizacionFinanciera(req: EnviarCotizacionRequest):
      Observable<{ message: string; email: string }> {
    return this.http.post<{ message: string; email: string }>(
      `${this.base}/cotizacion-financiera/enviar`, req);
  }

  // El stream SSE de /events lo maneja BackendStatusService — su Subject
  // `syncEvents$` se consume desde SyncStateService. Antes este método
  // creaba su propio EventSource, lo que abría una segunda conexión.
}
