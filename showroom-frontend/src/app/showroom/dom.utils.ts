/**
 * Utilidades de DOM compartidas entre componentes del showroom.
 */

/**
 * Al enfocar un input, selecciona todo su contenido para que el valor por
 * defecto (ej. el "0%" de los descuentos) o el valor previo se REEMPLACE al
 * tipear en vez de concatenarse (tipear "5" sobre "0" daba "05").
 *
 * <p>El {@code setTimeout} difiere el {@code select()} un tick: hecho de forma
 * síncrona, el colapso de selección que dispara el click del mouse lo pisaría.
 *
 * <p>Se usa como handler de {@code (onFocus)} de {@code p-inputNumber}, cuyo
 * evento emite el {@code FocusEvent} nativo (su {@code target} es el input).
 */
export function seleccionarTextoAlEnfocar(event: Event): void {
  const input = event.target as HTMLInputElement | null;
  if (input) setTimeout(() => input.select());
}
