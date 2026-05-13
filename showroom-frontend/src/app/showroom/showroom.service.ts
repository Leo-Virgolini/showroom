import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams, HttpResponse } from '@angular/common/http';
import { Observable } from 'rxjs';
import {
  CarritoAgregarResponse,
  CarritoState,
  CatalogoItem,
  CatalogoPage,
  CrearPedidoRequest,
  CrearPedidoResponse,
  EscalaDescuento,
  Health,
  HorarioSync,
  PickitConfig,
  ListarPedidosParams,
  ListarProductosParams,
  Localidad,
  PedidoDetalle,
  PedidoListPage,
  ProductoListPage,
  Provincia,
  RefreshStockRequest,
  ScanResult,
} from './models';

@Injectable({ providedIn: 'root' })
export class ShowroomService {
  private readonly http = inject(HttpClient);
  private readonly base = '/api/showroom';

  scan(sku: string): Observable<ScanResult> {
    return this.http.get<ScanResult>(`${this.base}/scan/${encodeURIComponent(sku)}`);
  }

  /** Llamada desde /visor cuando el cliente toca "Agregar al carrito" en el
   *  celular. El backend lo suma al carrito (único global) y emite SSE
   *  `carrito-updated`. La respuesta incluye cuánto se sumó realmente. */
  visorAgregarAlCarrito(sku: string, cantidad: number): Observable<CarritoAgregarResponse> {
    return this.http.post<CarritoAgregarResponse>(
      `${this.base}/visor/agregar-carrito`, { sku, cantidad });
  }

  // =====================================================
  // Carrito server-side (autenticado). El estado vive en el backend; las
  // pantallas se sincronizan via SSE carrito-updated.
  // =====================================================

  obtenerCarrito(): Observable<CarritoState> {
    return this.http.get<CarritoState>(`${this.base}/carrito`);
  }

  agregarItemCarrito(sku: string, cantidad: number): Observable<CarritoAgregarResponse> {
    return this.http.post<CarritoAgregarResponse>(
      `${this.base}/carrito/items`, { sku, cantidad });
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

  /** Horarios diarios de sincronización automática con DUX (zona AR). */
  obtenerHorariosSync(): Observable<HorarioSync[]> {
    return this.http.get<HorarioSync[]>(`${this.base}/config/horarios-sync`);
  }

  /** Reemplaza atómicamente la lista de horarios. El backend reprograma los disparos en el momento. */
  actualizarHorariosSync(horarios: HorarioSync[]): Observable<HorarioSync[]> {
    return this.http.put<HorarioSync[]>(`${this.base}/config/horarios-sync`, horarios);
  }

  /** Destinatario del email de picking (uno o varios mails separados por coma). */
  obtenerEmailPicking(): Observable<{ email: string }> {
    return this.http.get<{ email: string }>(`${this.base}/config/picking-email`);
  }

  /** Persiste el destinatario del email de picking. Cadena vacía vuelve al default. */
  actualizarEmailPicking(email: string): Observable<{ email: string }> {
    return this.http.put<{ email: string }>(`${this.base}/config/picking-email`, { email });
  }

  /** Config de la integración con el programa pickit-y-etiquetas. */
  obtenerPickitConfig(): Observable<PickitConfig> {
    return this.http.get<PickitConfig>(`${this.base}/config/pickit`);
  }

  actualizarPickitConfig(cfg: PickitConfig): Observable<PickitConfig> {
    return this.http.put<PickitConfig>(`${this.base}/config/pickit`, cfg);
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

  /** Anula un pedido. El backend marca estado=ANULADO, registra timestamp y
   *  motivo opcional. Devuelve el detalle ya actualizado. NO toca DUX —
   *  si el pedido había sido cargado allí, hay que cancelarlo manualmente. */
  anularPedido(id: number, motivo?: string | null): Observable<PedidoDetalle> {
    const body = motivo && motivo.trim() ? { motivo: motivo.trim() } : {};
    return this.http.post<PedidoDetalle>(`${this.base}/pedidos/${id}/anular`, body);
  }

  // El stream SSE de /events lo maneja BackendStatusService — su Subject
  // `syncEvents$` se consume desde SyncStateService. Antes este método
  // creaba su propio EventSource, lo que abría una segunda conexión.
}
