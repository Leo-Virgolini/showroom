# Unificar el marcador de maquinaria al criterio configurable

Fecha: 2026-06-29

## Objetivo

Que el **marcador visual** de maquinaria (badges/resaltado de filas) use el
**mismo criterio configurable** que el cálculo y el backend —
`PrecioPerfilService.rubroCotizaSinIva` (lista `rubrosSinIva` editable en
`/configuracion`)— en vez de la lista **hardcoded** `RUBROS_SIN_DESCUENTO_ESCALA`
del frontend. Eliminar la lista hardcoded.

## Contexto / diagnóstico

- En el frontend hay dos detecciones del "rubro de maquinaria":
  - `rubroCotizaSinIva` (`PrecioPerfilService`) — **configurable** (la lista la
    edita el dueño en `/configuracion`, se carga del backend).
  - `rubroExcluyeDescuentos` + `RUBROS_SIN_DESCUENTO_ESCALA = {'MAQUINAS
    INDUSTRIALES'}` (`models.ts`) — **hardcoded**.
- El **backend** trata ambos conceptos como UNA sola lista configurable
  (`precios.rubros-sin-iva`; regla confirmada por el dueño el 2026-05-29).
- El **cálculo** de descuentos por escala del frontend **ya usa el criterio
  configurable** (`rubroCotizaSinIva`) — no hay bug de cálculo/facturación.
- El único que quedó hardcoded es el **marcador visual** `esRubroMaquinaria`
  (alias de `rubroExcluyeDescuentos`) en 6 componentes. Si se edita la lista en
  `/configuracion`, el cálculo es correcto pero los badges no marcarían el rubro
  nuevo → inconsistencia visual (latente, hoy invisible porque ambas listas
  coinciden en `MAQUINAS INDUSTRIALES`).

## Diseño

### 1. Marcador `esRubroMaquinaria` → criterio configurable (6 componentes)

En cada componente con `protected readonly esRubroMaquinaria = rubroExcluyeDescuentos;`,
reemplazar por un método que delegue en el servicio configurable:

```typescript
esRubroMaquinaria(rubro: string | null | undefined): boolean {
  return this.precioPerfil.rubroCotizaSinIva(rubro);
}
```

Componentes: `showroom-page`, `presupuestos-page`, `historial-page`,
`presupuestos-historial-page`, `productos-page`, `pedidos-page`. (El template
sigue llamando `esRubroMaquinaria(...)` igual — sin cambios de HTML.)

### 2. Inyectar `PrecioPerfilService` donde falte

`productos-page` y `pedidos-page` no inyectan el servicio: agregar
`private readonly precioPerfil = inject(PrecioPerfilService);`. Los otros 4 ya lo
tienen.

### 3. Asegurar que la lista esté cargada

`rubroCotizaSinIva` devuelve false si la lista `rubrosSinIva` está vacía. El
servicio es singleton (`providedIn: 'root'`), pero cada componente que dependa de
la lista debe llamar `this.precioPerfil.cargar()` al entrar para no depender de
que otro la haya cargado antes (y para reflejar cambios de `/configuracion`).
`showroom-page` y `presupuestos-page` ya lo hacen; verificar
`historial-page`, `presupuestos-historial-page`, `productos-page`, `pedidos-page`
y agregar la llamada donde falte (en el init del componente).

### 4. Eliminar el hardcoded de `models.ts`

Quitar `RUBROS_SIN_DESCUENTO_ESCALA` y la función `rubroExcluyeDescuentos` de
`models.ts` (quedan sin uso tras el punto 1) y sus imports en los componentes.
`normalizarRubro` se mantiene (lo usa el servicio).

## Compatibilidad / riesgo

- **Solo visual.** El cálculo de descuentos por escala y la facturación no
  cambian (ya usaban `rubroCotizaSinIva`).
- Hoy es invisible (ambas listas = `MAQUINAS INDUSTRIALES`). El cambio alinea el
  badge con la config para cuando difieran.
- `cotizador-page` no usa el marcador — no se toca.

## Out of scope (YAGNI)

- No se cambia la lógica de cálculo (ya correcta).
- No se toca el backend (ya usa el criterio configurable).
- No se cambia la pantalla `/configuracion`.

## Verificación

- Frontend compila (`cd showroom-frontend && npm run build`).
- Manual: el badge/resaltado de maquinaria sigue apareciendo en
  productos/showroom/presupuestos/historiales para `MAQUINAS INDUSTRIALES`.
- Manual (la mejora): agregar un rubro a "rubros sin IVA" en `/configuracion` →
  los ítems de ese rubro ahora también se marcan visualmente (antes no, con la
  lista hardcoded).
- `grep rubroExcluyeDescuentos|RUBROS_SIN_DESCUENTO_ESCALA` en el frontend → 0
  resultados.
