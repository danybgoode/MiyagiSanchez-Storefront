/**
 * lib/negocio-pricing.ts — the ONE home of Negocio's prices (epic 08 · plans-gratis-negocio, README D2).
 *
 * Every surface that states what Negocio costs (the checkout routes, `/mx/precios` through the pricing catalog,
 * «Tu suscripción», the agent tools) imports from here. `e2e/pricing-source-sweep.spec.ts` fails on a typed MXN
 * price in copy, so a price changed here reaches all of them.
 *
 * Monthly is a Stripe subscription on the Negocio plan's price (seeded by `scripts/seed-negocio-plan.mjs`). Yearly is
 * ONE payment that grants 12 months: Stripe offers meses sin intereses only on one-time payments (README D3).
 */

export const NEGOCIO_CURRENCY = 'MXN'

export const NEGOCIO_PRICE_MONTHLY_MXN = 149
export const NEGOCIO_PRICE_MONTHLY_CENTS = NEGOCIO_PRICE_MONTHLY_MXN * 100

export const NEGOCIO_PRICE_YEARLY_MXN = 1490
export const NEGOCIO_PRICE_YEARLY_CENTS = NEGOCIO_PRICE_YEARLY_MXN * 100

/** Months a yearly payment grants. */
export const NEGOCIO_YEARLY_MONTHS = 12

/** Length of the Negocio trial every shop gets once (Daniel, 2026-11-04). */
export const NEGOCIO_TRIAL_DAYS = 30
