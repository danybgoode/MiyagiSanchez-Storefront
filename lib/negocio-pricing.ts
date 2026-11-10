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

/**
 * Length of the Negocio trial every shop gets once: three months (plan-tienda-three-free-months D7; it was 30 days
 * from 2026-11-04). A trial already stamped keeps its own `expires_at` (`buildNegocioTrial` writes the end into the
 * shop once), so changing this moves only trials stamped from now on — the 18 live trials still end on 2026-12-05.
 * Every page that says the length reads it through `trialLengthLabel` («3 meses»), never typed.
 */
export const NEGOCIO_TRIAL_DAYS = 90
