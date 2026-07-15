import { describe, it, expect, vi, beforeEach } from 'vitest';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { MessageService } from 'primeng/api';
import { CrearPedidoDialog, PedidoItemEntrada } from './crear-pedido-dialog';
import { ShowroomService } from '../showroom.service';
import { BackendStatusService } from '../backend-status.service';
import { FormaPago } from '../models';

const EFECTIVO = {
  id: 5, nombre: 'Efectivo', recargoPorcentaje: 0, cantidadCuotas: 1, aplicaIva: true,
  recargoPorcentajeMaquinaria: null, aplicaIvaMaquinaria: null, activo: true, orden: 1,
} as FormaPago;

const ITEMS: PedidoItemEntrada[] = [{
  sku: '1016506', cantidad: 2, precioConIva: 1210, porcIva: 21,
  descuentoPorcentaje: null, rubro: 'MENAJE', comentarios: null,
}];

function mockApi() {
  return {
    listarFormasPagoActivas: vi.fn(() => of([EFECTIVO])),
    obtenerRubrosSinIva: vi.fn(() => of([] as string[])),
    obtenerProvincias: vi.fn(() => of([])),
    obtenerLocalidades: vi.fn(() => of([])),
    buscarClientePorCuit: vi.fn(() => of(null)),
    lookupBulk: vi.fn(() => of([])),
    obtenerPedido: vi.fn(() => of({
      id: 99, estado: 'ENVIADO', nroDoc: null, domicilio: null, formaPagoId: null,
      observaciones: null, codigoProvincia: null, idLocalidad: null,
    })),
  };
}

/** Monta el dialog en modo "editar pedido" (sin presupuesto detrás): ítems por
 *  input + `pedidoAnteriorId`. Template vacío — lo que se ejercita es el effect
 *  de inicialización, no la UI de PrimeNG. */
function montar(api: ReturnType<typeof mockApi>, formaPagoId: number | null) {
  TestBed.configureTestingModule({
    imports: [CrearPedidoDialog],
    providers: [
      { provide: ShowroomService, useValue: api },
      { provide: BackendStatusService, useValue: { skuProductoGenerico: signal(null) } },
      MessageService,
    ],
  });
  TestBed.overrideComponent(CrearPedidoDialog, { set: { template: '' } });
  const fixture = TestBed.createComponent(CrearPedidoDialog);
  fixture.componentRef.setInput('items', ITEMS);
  fixture.componentRef.setInput('presupuestoId', null);
  fixture.componentRef.setInput('pedidoAnteriorId', 99);
  fixture.componentRef.setInput('clientePrefill', { nombre: 'Juan', formaPagoId });
  fixture.componentRef.setInput('visible', true);
  fixture.detectChanges();
  return fixture;
}

describe('CrearPedidoDialog — inicialización desde ítems (editar pedido)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  // El prefill sin forma de pago es el caso normal cuando el operador dejó el
  // comparativo en "Todas" y el pedido original tampoco tenía forma. La
  // inicialización la resetea a null y el fallback la vuelve a poner en la
  // primera activa: si ambas escrituras quedan dentro del effect, oscilan y el
  // effect se re-ejecuta para siempre (cuelga la pestaña y satura de GETs).
  it('no re-ejecuta la inicialización cuando el prefill no trae forma de pago', () => {
    const api = mockApi();
    montar(api, null);
    expect(api.obtenerPedido).toHaveBeenCalledTimes(1);
  }, 10_000);

  it('cae a la primera forma activa cuando el prefill no trae ninguna', () => {
    const api = mockApi();
    const fixture = montar(api, null);
    expect(fixture.componentInstance.pedidoFormaPagoId()).toBe(5);
  }, 10_000);

  it('respeta la forma elegida por el operador y no re-inicializa', () => {
    const api = mockApi();
    const fixture = montar(api, 5);
    expect(fixture.componentInstance.pedidoFormaPagoId()).toBe(5);
    expect(api.obtenerPedido).toHaveBeenCalledTimes(1);
  }, 10_000);
});
