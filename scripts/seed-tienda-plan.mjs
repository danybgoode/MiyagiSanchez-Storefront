/**
 * One-off seed (epic 08 · plan-tienda-three-free-months S2.2, README D3). Modelled exactly on
 * scripts/seed-negocio-plan.mjs, for Plan Tienda, with ONE cadence: monthly. Plan Tienda's yearly price is a one-time
 * payment with inline `price_data` (it needs no Stripe Price), so only the monthly recurring price is seeded.
 *
 *   1. Find or create the Stripe Product + monthly Price — $29 MXN/mo, IVA included — on the PLATFORM Stripe account
 *      (the platform is the payee). Idempotent through the Price `lookup_key`.
 *   2. POST the price id to the Backend's `/internal/setup-tienda-plan`, which upserts the ONE Medusa Commerce
 *      SubscriptionPlan (`metadata.kind = tienda_plan`; Backend #228).
 *
 * ⚠️  RUN ORDER: after the Backend deploy that ships /internal/setup-tienda-plan, with PROD credentials (sk_live,
 *     the production Backend URL and MEDUSA_INTERNAL_SECRET from the VM env files), not the dev .env.local. Until it
 *     runs, the monthly Plan Tienda button answers "no disponible" and the yearly one still works.
 *
 * Run:  node --env-file=<prod env> scripts/seed-tienda-plan.mjs
 * Idempotent — re-runs reuse the same Stripe Price and update the same Medusa plan. A 409 from the Backend means the
 * price id is already on another platform plan, or two Tienda plans exist; either must be resolved by hand.
 *
 * Env: STRIPE_SECRET_KEY, MEDUSA_STORE_URL, MEDUSA_INTERNAL_SECRET.
 */

import Stripe from 'stripe'

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY
const MEDUSA_BASE = process.env.MEDUSA_STORE_URL
const INTERNAL_SECRET = process.env.MEDUSA_INTERNAL_SECRET

if (!STRIPE_SECRET_KEY || !MEDUSA_BASE || !INTERNAL_SECRET) {
  console.error('Missing STRIPE_SECRET_KEY / MEDUSA_STORE_URL / MEDUSA_INTERNAL_SECRET')
  process.exit(1)
}

// Keep in step with lib/tienda-pricing.ts (TIENDA_PRICE_MONTHLY_CENTS). A .mjs script cannot import the TS module.
const MONTHLY_CENTS = 2900 // $29 MXN / month, IVA included
const CURRENCY = 'mxn'
// Keep in step with lib/plan-kind.ts (PLAN_PRICE_LOOKUP_KEYS.tienda): the webhook cross-checks it to tell a Tienda
// subscription from a Negocio one.
const LOOKUP_KEY = 'tienda_monthly'

const stripe = new Stripe(STRIPE_SECRET_KEY)

async function ensureMonthlyPrice() {
  const found = await stripe.prices.list({ lookup_keys: [LOOKUP_KEY], active: true, limit: 1 })
  if (found.data.length > 0) {
    const price = found.data[0]
    if (price.unit_amount !== MONTHLY_CENTS || price.currency !== CURRENCY) {
      console.error(`Existing price ${price.id} is ${price.unit_amount} ${price.currency}, expected ${MONTHLY_CENTS} ${CURRENCY}. Refusing to seed a different price — archive it in Stripe first.`)
      process.exit(1)
    }
    console.log(`Reusing existing Stripe price ${price.id} (lookup_key=${LOOKUP_KEY}).`)
    return price
  }
  const product = await stripe.products.create({
    name: 'Plan Tienda — Miyagi Sánchez',
    description: 'Plan Tienda de Miyagi Sánchez: tu tienda en línea, sin comisión por venta.',
    metadata: { kind: 'tienda_plan' },
  })
  const price = await stripe.prices.create({
    product: product.id,
    unit_amount: MONTHLY_CENTS,
    currency: CURRENCY,
    recurring: { interval: 'month' },
    lookup_key: LOOKUP_KEY,
    metadata: { kind: 'tienda_plan' },
  })
  console.log(`Created Stripe product ${product.id} + price ${price.id} (month).`)
  return price
}

const price = await ensureMonthlyPrice()
const res = await fetch(`${MEDUSA_BASE}/internal/setup-tienda-plan`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-internal-secret': INTERNAL_SECRET },
  body: JSON.stringify({ stripe_price_id: price.id, price_cents: MONTHLY_CENTS }),
})
if (!res.ok) {
  console.error('Backend seed failed:', res.status, await res.text())
  process.exit(1)
}
const body = await res.json()
console.log(`Tienda plan ${body.created ? 'created' : 'updated'}: ${body.plan?.id} → ${price.id}`)
