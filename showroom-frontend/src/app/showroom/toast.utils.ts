import { MessageService } from 'primeng/api';

/**
 * Helper para mostrar un toast de error a partir de la respuesta HTTP del backend.
 * El backend normaliza errores con `{ message, path }` (GlobalExceptionHandler).
 */
export function toastError(
  toast: MessageService,
  summary: string,
  err: unknown,
  fallback: string,
): void {
  const e = err as { error?: { message?: string } } | undefined;
  toast.add({
    severity: 'error',
    summary,
    detail: e?.error?.message ?? fallback,
  });
}
