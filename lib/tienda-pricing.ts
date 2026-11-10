/**
 * lib/tienda-pricing.ts — the ONE home of Plan Tienda's prices (epic 08 · plan-tienda-three-free-months, README D5).
 *
 * Every surface that states what Plan Tienda costs (its checkout route, `/mx/precios` through the pricing catalog,
 * «Tu suscripción», the agent tools, `/acerca`) imports from here. `e2e/pricing-source-sweep.spec.ts` fails on a typed
 * MXN price in copy, so a price changed here reaches all of them.
 *
 * Prices INCLUDE IVA (Daniel, 2026-11-09); every page that shows them says «IVA incluido».
 *
 * «desde $19 al mes» is NOT a constant: it is the yearly price spread over twelve months
 * (`yearlyAsMonthly(TIENDA_PRICE_YEARLY_MXN)` in `lib/pricing-catalog.ts`), so it can never disagree with what the
 * yearly checkout charges.
 *
 * Monthly is a Stripe subscription on the Tienda plan's price, seeded by `scripts/seed-tienda-plan.mjs` (which must
 * be kept in step with `TIENDA_PRICE_MONTHLY_CENTS` by hand: a .mjs script cannot import this module). Yearly is ONE
 * card payment that grants `TIENDA_YEARLY_MONTHS` (README D3).
 */

export const TIENDA_CURRENCY = 'MXN'

export const TIENDA_PRICE_MONTHLY_MXN = 29
export const TIENDA_PRICE_MONTHLY_CENTS = TIENDA_PRICE_MONTHLY_MXN * 100

export const TIENDA_PRICE_YEARLY_MXN = 228
export const TIENDA_PRICE_YEARLY_CENTS = TIENDA_PRICE_YEARLY_MXN * 100

/** Months a yearly Plan Tienda payment grants. */
export const TIENDA_YEARLY_MONTHS = 12
