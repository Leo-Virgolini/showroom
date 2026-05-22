import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams, HttpResponse } from '@angular/common/http';
import { Observable } from 'rxjs';
import {
  CarritoAgregarResponse,
  CarritoState,
  CatalogoItem,
  CatalogoPage,
  ClientePresupuestos,
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
  PresupuestoListPage,
  ProductoListPage,
  Provincia,
  RefreshStockRequest,
  ScanResult,
  SesionDetalle,
  SesionListPage,
  SesionShowroom,
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

  /** Estado de la sesión activa de un operador específico — endpoint público
   *  que usa el visor para mostrar el nombre del cliente actual. */
  visorObtenerSesionActiva(username: string): Observable<SesionShowroom> {
    return this.http.get<SesionShowroom>(
      `${this.base}/visor/${encodeURIComponent(username)}/sesion/activa`);
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

  actualizarCantidadItemCarrito(sku: string, cantidad: number): Observable<CarritoState> {
    return this.http.patch<CarritoState>(
      `${this.base}/carrito/items/${encodeURIComponent(sku)}`, { cantidad });
  }

  eliminarItemCarrito(sku: string): Observable<CarritoState> {
    return this.http.delete<CarritoState>(
      `${this.base}/carrito/items/${encodeURIComponent(sku)}`);
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

  syncCatalogo(force = false): Observable<{ message: string }> {
    let params = new HttpParams();
    if (force) params = params.set('force', 'true');
    return this.http.post<{ message: string }>(`${this.base}/sync-catalogo`, {}, { params });
  }

  cancelarSync(): Observable<{ message: string }> {
    return this.http.post<{ message: string }>(`${this.base}/sync-catalogo/cancelar`, {});
  }

  buscarCatalogo(q: string, page = 0, size = 50): Observable<CatalogoPage> {
    let params = new HttpParams().set('page', page).set('size', size);
    if (q && q.trim()) params = params.set('q', q.trim());
    return this.http.get<CatalogoPage>(`${this.base}/catalogo`, { params });
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
    if (opts.sortField) params = params.set('sortField', opts.sortField);
    if (opts.sortOrder) params = params.set('sortOrder', opts.sortOrder);
    return this.http.get<ProductoListPage>(`${this.base}/productos`, { params });
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

  /** Regenera el pickit externo manualmente para un pedido ya existente. El
   *  resultado llega vía SSE pickit-externo (toast). */
  regenerarPickitExterno(id: number): Observable<{ message: string; pedidoId: number }> {
    return this.http.post<{ message: string; pedidoId: number }>(
      `${this.base}/pedidos/${id}/pickit-externo`, {});
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

  descargarPdfPedido(id: number): Observable<HttpResponse<Blob>> {
    return this.http.get(`${this.base}/pedidos/${id}/pdf`, {
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
    return this.http.get<PresupuestoListPage>(`${this.base}/presupuesto-comercial`, { params });
  }

  /** Lista de clientes únicos derivados de los presupuestos guardados —
   *  agrupados SOLO por email (los presupuestos sin email no se cuentan),
   *  con datos canónicos del presupuesto más reciente. Sin paginar. */
  listarClientesPresupuestos(): Observable<ClientePresupuestos[]> {
    return this.http.get<ClientePresupuestos[]>(`${this.base}/presupuesto-comercial/clientes`);
  }

  /** Elimina (soft-delete) un presupuesto del historial. El registro
   *  físicamente persiste en la DB con `eliminado_at` poblado, pero deja
   *  de aparecer en el listado del historial. */
  eliminarPresupuestoComercial(id: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/presupuesto-comercial/${id}`);
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

  // El stream SSE de /events lo maneja BackendStatusService — su Subject
  // `syncEvents$` se consume desde SyncStateService. Antes este método
  // creaba su propio EventSource, lo que abría una segunda conexión.
}
