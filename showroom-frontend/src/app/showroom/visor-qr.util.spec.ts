import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { construirVisorUrl } from './visor-qr.util';

describe('construirVisorUrl', () => {
  beforeEach(() => {
    // Mock window para el test (por defecto es undefined en Node)
    vi.stubGlobal('window', { location: { origin: 'http://fallback' } });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('arma base/segmento/token con el token escapado', () => {
    const url = construirVisorUrl('http://192.168.1.50:4200', 'abc-123', 'visor');
    expect(url).toBe('http://192.168.1.50:4200/visor/abc-123');
  });

  it('usa el segmento visor-presupuesto', () => {
    const url = construirVisorUrl('http://host', 'tok', 'visor-presupuesto');
    expect(url).toBe('http://host/visor-presupuesto/tok');
  });
});
