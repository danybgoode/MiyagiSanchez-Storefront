/**
 * The «Vendiste más de lo que tenías en inventario» flag (in-person-sales S3.2, D12). Pure.
 * The backend's `in_person_oversold` is an array of { variant_id, quantity, decrement, shortfall }
 * or null; anything malformed reads as "no flag" rather than inventing one.
 */
export interface OversoldLine { variant_id: string; quantity: number; decrement: number; shortfall: number }

export const OVERSOLD_LABEL = 'Vendiste más de lo que tenías en inventario'

export function oversoldLines(raw: unknown): OversoldLine[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((l): l is OversoldLine =>
    !!l && typeof l.variant_id === 'string' && Number.isFinite(l.shortfall) && l.shortfall > 0 && Number.isFinite(l.quantity))
}

export function isOversold(raw: unknown): boolean {
  return oversoldLines(raw).length > 0
}

/** «Faltaron 3 unidades en total» — the short units across lines. */
export function oversoldSummary(raw: unknown): string | null {
  const lines = oversoldLines(raw)
  if (lines.length === 0) return null
  const units = lines.reduce((sum, l) => sum + l.shortfall, 0)
  return `Faltaron ${units} ${units === 1 ? 'unidad' : 'unidades'} en ${lines.length} ${lines.length === 1 ? 'producto' : 'productos'}.`
}
