/**
 * Counter cart — the money math behind «Vender en persona» (in-person-sales S1.1).
 *
 * PURE ON PURPOSE: no React, no `next`, no I/O, no clock. The counter screen holds a
 * `CounterCart` in state and calls these functions; the only thing the network ever
 * sees is `toSaleLines()` plus a tendered amount. That is why every branch of the
 * change calculation is reachable from the `api` Playwright project with no phone.
 *
 * INTEGER CENTAVOS ONLY. A float peso total (0.1 + 0.2) is how a till ends up a centavo
 * off at the end of the day, and the backend refuses a non-integer `tendered_cents`
 * anyway (400). Any money that is not a non-negative safe integer THROWS here rather than
 * being rounded: a silent round turns a bug in a caller into a wrong charge. Quantity is
 * different in kind (a count the merchant taps, not a price), so it is CLAMPED to 1..999 —
 * the same bounds the backend enforces (D3) — and never throws.
 *
 * Lines are keyed by VARIANT, not product: the backend proves ownership and takes stock
 * per variant (D3), and two taps on two variants of one product are two lines.
 */

/** The backend's per-line quantity bounds (architecture lock D3). */
export const MIN_QUANTITY = 1
export const MAX_QUANTITY = 999

/** What the grid hands the cart when the merchant taps a variant. */
export interface CounterItem {
  variantId: string
  productId: string
  title: string
  /** «Chica», «Azul / M»… null for a single-variant product. */
  variantTitle?: string | null
  /** Integer centavos. */
  unitCents: number
  imageUrl?: string | null
  /**
   * Units that can still be sold (stocked minus reserved), or null when stock is not
   * tracked / the product is sold on backorder. The cart never lets a line pass it.
   */
  maxQuantity?: number | null
}

export interface CartLine {
  variantId: string
  productId: string
  title: string
  variantTitle: string | null
  unitCents: number
  imageUrl: string | null
  maxQuantity: number | null
  quantity: number
}

export interface CounterCart {
  lines: readonly CartLine[]
}

export interface SaleLine {
  variant_id: string
  quantity: number
}

export function emptyCart(): CounterCart {
  return { lines: [] }
}

/** Throws unless `value` is a non-negative safe integer number of centavos. */
export function assertCents(value: unknown, label = 'cents'): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative integer number of centavos, got ${String(value)}`)
  }
}

/** Quantity is clamped, never thrown on: NaN, fractions and out-of-range all land in 1..999. */
export function clampQuantity(value: number, max: number | null = null): number {
  const cap = max !== null && Number.isFinite(max) ? Math.max(MIN_QUANTITY, Math.min(MAX_QUANTITY, Math.floor(max))) : MAX_QUANTITY
  if (!Number.isFinite(value)) return MIN_QUANTITY
  return Math.min(cap, Math.max(MIN_QUANTITY, Math.floor(value)))
}

function indexOfVariant(cart: CounterCart, variantId: string): number {
  return cart.lines.findIndex((line) => line.variantId === variantId)
}

/** Add `quantity` of an item; the same variant merges into its existing line. */
export function addItem(cart: CounterCart, item: CounterItem, quantity = 1): CounterCart {
  assertCents(item.unitCents, 'unitCents')
  const max = item.maxQuantity ?? null
  const at = indexOfVariant(cart, item.variantId)
  if (at === -1) {
    const line: CartLine = {
      variantId: item.variantId,
      productId: item.productId,
      title: item.title,
      variantTitle: item.variantTitle ?? null,
      unitCents: item.unitCents,
      imageUrl: item.imageUrl ?? null,
      maxQuantity: max,
      quantity: clampQuantity(quantity, max),
    }
    return { lines: [...cart.lines, line] }
  }
  const existing = cart.lines[at]
  const lines = cart.lines.slice()
  lines[at] = { ...existing, quantity: clampQuantity(existing.quantity + Math.floor(quantity), existing.maxQuantity) }
  return { lines }
}

export function incrementLine(cart: CounterCart, variantId: string): CounterCart {
  const at = indexOfVariant(cart, variantId)
  if (at === -1) return cart
  const line = cart.lines[at]
  const lines = cart.lines.slice()
  lines[at] = { ...line, quantity: clampQuantity(line.quantity + 1, line.maxQuantity) }
  return { lines }
}

/** Minus one; a line at 1 is REMOVED — a cart never holds a zero-quantity line. */
export function decrementLine(cart: CounterCart, variantId: string): CounterCart {
  const at = indexOfVariant(cart, variantId)
  if (at === -1) return cart
  const line = cart.lines[at]
  if (line.quantity <= MIN_QUANTITY) return removeLine(cart, variantId)
  const lines = cart.lines.slice()
  lines[at] = { ...line, quantity: line.quantity - 1 }
  return { lines }
}

export function removeLine(cart: CounterCart, variantId: string): CounterCart {
  if (indexOfVariant(cart, variantId) === -1) return cart
  return { lines: cart.lines.filter((line) => line.variantId !== variantId) }
}

export function clearCart(): CounterCart {
  return emptyCart()
}

export function lineTotalCents(line: CartLine): number {
  assertCents(line.unitCents, 'unitCents')
  const total = line.unitCents * clampQuantity(line.quantity)
  assertCents(total, 'line total')
  return total
}

export function cartTotalCents(cart: CounterCart): number {
  const total = cart.lines.reduce((sum, line) => sum + lineTotalCents(line), 0)
  assertCents(total, 'cart total')
  return total
}

/** Units across all lines — the badge on the cart button. */
export function cartUnits(cart: CounterCart): number {
  return cart.lines.reduce((sum, line) => sum + line.quantity, 0)
}

export interface CashResult {
  /** «Cambio» — what the merchant hands back. 0 when the cash is short. */
  change_cents: number
  /** «Falta» — what is still owed. 0 when the cash covers the total. */
  short_cents: number
}

/**
 * Cash at the counter. Exactly one of the two is non-zero unless the tender is exact
 * (both 0). A tender of 0 against a positive total is «Falta» the whole total — an empty
 * pad is not «paid».
 */
export function cashResult(totalCents: number, tenderedCents: number): CashResult {
  assertCents(totalCents, 'totalCents')
  assertCents(tenderedCents, 'tenderedCents')
  return tenderedCents >= totalCents
    ? { change_cents: tenderedCents - totalCents, short_cents: 0 }
    : { change_cents: 0, short_cents: totalCents - tenderedCents }
}

/**
 * The backend `lines`, MERGED by variant_id. A cart built through `addItem` is already
 * unique per variant; merging here too means a hand-built or restored cart can never send
 * two lines for one variant (the backend would count them separately against stock).
 * First-seen order is kept so the receipt matches the screen.
 */
export function toSaleLines(cart: CounterCart): SaleLine[] {
  const byVariant = new Map<string, number>()
  for (const line of cart.lines) {
    byVariant.set(line.variantId, (byVariant.get(line.variantId) ?? 0) + clampQuantity(line.quantity))
  }
  return [...byVariant].map(([variant_id, quantity]) => ({ variant_id, quantity: Math.min(MAX_QUANTITY, quantity) }))
}

/**
 * The amount pad's text → centavos. «250» = $250.00, «250.5» = $250.50. Returns null for
 * anything that is not a plain amount (empty, signs, exponents, a third decimal), so the
 * caller shows nothing rather than a guess.
 */
export function parsePesosToCents(text: string): number | null {
  const trimmed = text.trim()
  const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(trimmed)
  if (!match) return null
  const cents = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0') || '0')
  return Number.isSafeInteger(cents) ? cents : null
}

export type PadKey = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '.' | 'del'

/**
 * One tap on the amount pad. Returns the new text, or the SAME text when the key would make
 * an amount `parsePesosToCents` could not read (a second dot, a third decimal, 10 digits,
 * a leading zero run) — the pad refuses at the keystroke instead of failing later.
 */
export function applyPadKey(text: string, key: PadKey): string {
  if (key === 'del') return text.slice(0, -1)
  if (key === '.') return text.includes('.') ? text : `${text === '' ? '0' : text}.`
  const next = text === '0' ? key : text + key
  return /^\d{1,9}(\.\d{0,2})?$/.test(next) ? next : text
}

/** The pad text as centavos; a trailing dot («12.») still reads as 12. Empty/invalid = null. */
export function padTextToCents(text: string): number | null {
  return parsePesosToCents(text.endsWith('.') ? text.slice(0, -1) : text)
}

/** Centavos → pad text without trailing zeros («Exacto» button): 24050 → «240.5», 24000 → «240». */
export function centsToPadText(cents: number): string {
  assertCents(cents, 'cents')
  const pesos = Math.floor(cents / 100)
  const rest = cents % 100
  if (rest === 0) return String(pesos)
  return `${pesos}.${String(rest).padStart(2, '0').replace(/0$/, '')}`
}
