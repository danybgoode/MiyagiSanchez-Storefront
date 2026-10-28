/**
 * lib/cost-comparator.ts
 *
 * Comparador de costos (epic 08 · cost-comparator-homepage, Sprint 1 · US-1.1) — the
 * PURE stacked-cost model. Zero `next/*`, zero `server-only`, zero network: every
 * function here takes plain numeric rates + a merchant's own inputs and returns a
 * deterministic breakdown. Kept next-free/server-only-free like `lib/slug.ts` and
 * `lib/profit.ts` so the Playwright `api` runner can import it directly with no
 * framework in the require graph.
 *
 * This file has NO idea where its rates come from — it never reads the sourced
 * dataset or the Supabase overrides table. `lib/cost-comparator-dataset.ts`
 * (`ratesFromDataset`) is the pure adapter that turns the versioned, sourced JSON
 * dataset into the rate bags this file consumes; `lib/cost-comparator-data.ts` is
 * the server-only glue that fetches + merges overrides before calling it. That
 * split is what makes "every input user-overridable" cheap: an override just
 * produces a different rate bag, and every function below is a pure function of
 * (inputs, rates) — no override-specific branch anywhere in the arithmetic.
 *
 * All money is expressed in MXN pesos (not centavos) as JS numbers — the amounts
 * here are display-only (a comparison tool, not a checkout charge), so float MXN
 * is the simplest honest representation. Every `*Rates` shape is a plain object of
 * numbers so a unit spec can construct one inline without touching the dataset.
 */

// ---------------------------------------------------------------------------
// Shared inputs
// ---------------------------------------------------------------------------

/** What every platform's cost is computed FROM — the merchant's own numbers. */
export interface ComparatorInputs {
  /** Sales per month. */
  volumeMonthly: number
  /** Average order value, MXN. */
  aovMxn: number
}

export interface StackedCostLine {
  key: string
  label: string
  monthlyMxn: number
}

export interface StackedCost {
  lines: StackedCostLine[]
  monthlyTotalMxn: number
  annualTotalMxn: number
}

function revenueMxn(inputs: ComparatorInputs): number {
  return Math.max(0, inputs.volumeMonthly) * Math.max(0, inputs.aovMxn)
}

function stack(lines: StackedCostLine[]): StackedCost {
  const monthlyTotalMxn = round2(lines.reduce((sum, l) => sum + l.monthlyMxn, 0))
  return { lines: lines.map((l) => ({ ...l, monthlyMxn: round2(l.monthlyMxn) })), monthlyTotalMxn, annualTotalMxn: round2(monthlyTotalMxn * 12) }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

// ---------------------------------------------------------------------------
// Shopify — plan tiers + payment-processing rate, both tier-dependent
// ---------------------------------------------------------------------------

export type ShopifyTier = 'basico' | 'crecimiento' | 'avanzado'

export interface ShopifyRates {
  /** Monthly plan fee, USD, per tier. */
  planMonthlyUsd: Record<ShopifyTier, number>
  /** Shopify Payments card rate, %, per tier. */
  paymentPct: Record<ShopifyTier, number>
  /** Shopify Payments fixed fee per transaction, MXN (flat across tiers). */
  paymentFixedMxn: number
  /** USD → MXN, applied to the plan fee (billed in USD). */
  fxUsdToMxn: number
}

export function computeShopifyCost(
  inputs: ComparatorInputs,
  tier: ShopifyTier,
  rates: ShopifyRates,
  appsMonthlyMxn = 0,
): StackedCost {
  const revenue = revenueMxn(inputs)
  const planMxn = rates.planMonthlyUsd[tier] * rates.fxUsdToMxn
  const paymentMxn = revenue * (rates.paymentPct[tier] / 100) + inputs.volumeMonthly * rates.paymentFixedMxn
  return stack([
    { key: 'plan', label: 'Plan mensual', monthlyMxn: planMxn },
    { key: 'payment', label: 'Procesamiento de pago', monthlyMxn: paymentMxn },
    { key: 'apps', label: 'Apps premium', monthlyMxn: appsMonthlyMxn },
  ])
}

// ---------------------------------------------------------------------------
// Mercado Libre — no monthly fee; commission % by category band + publication
// type, plus a fixed low-price surcharge on Clásica listings only
// ---------------------------------------------------------------------------

export type MlBand = 'baja' | 'media' | 'alta'
export type MlPublicationType = 'clasica' | 'premium'

export interface MercadoLibreRates {
  commissionPct: Record<MlBand, Record<MlPublicationType, number>>
  /** Clásica-only fixed surcharge per unit, MXN, by price bracket. */
  fixedFeeMxn: { under99: number; under149: number; under299: number }
}

export function computeMercadoLibreCost(
  inputs: ComparatorInputs,
  band: MlBand,
  publicationType: MlPublicationType,
  rates: MercadoLibreRates,
  appsMonthlyMxn = 0,
): StackedCost {
  const revenue = revenueMxn(inputs)
  const pct = rates.commissionPct[band][publicationType]
  const commissionMxn = revenue * (pct / 100)

  // The fixed surcharge only applies to Clásica listings under $299 MXN — Premium
  // never carries it, and items ≥$299 never carry it either (mercadolibre-sync
  // dataset, sourced in the dataset JSON).
  let fixedPerUnit = 0
  if (publicationType === 'clasica') {
    if (inputs.aovMxn < 99) fixedPerUnit = rates.fixedFeeMxn.under99
    else if (inputs.aovMxn < 149) fixedPerUnit = rates.fixedFeeMxn.under149
    else if (inputs.aovMxn < 299) fixedPerUnit = rates.fixedFeeMxn.under299
  }
  const fixedFeeMxn = fixedPerUnit * inputs.volumeMonthly

  return stack([
    { key: 'commission', label: `Comisión (${publicationType === 'clasica' ? 'Clásica' : 'Premium'})`, monthlyMxn: commissionMxn },
    { key: 'fixedFee', label: 'Cargo fijo por precio bajo', monthlyMxn: fixedFeeMxn },
    { key: 'apps', label: 'Apps premium', monthlyMxn: appsMonthlyMxn },
  ])
}

// ---------------------------------------------------------------------------
// WooCommerce — self-hosted; cost = hosting tier + your own payment gateway
// ---------------------------------------------------------------------------

export type WooCommerceHostingTier = 'entrada' | 'crecimiento'

export interface WooCommerceRates {
  hostingMonthlyUsd: Record<WooCommerceHostingTier, number>
  paymentPct: number
  paymentFixedMxn: number
  fxUsdToMxn: number
}

export function computeWooCommerceCost(
  inputs: ComparatorInputs,
  hostingTier: WooCommerceHostingTier,
  rates: WooCommerceRates,
  appsMonthlyMxn = 0,
): StackedCost {
  const revenue = revenueMxn(inputs)
  const hostingMxn = rates.hostingMonthlyUsd[hostingTier] * rates.fxUsdToMxn
  const paymentMxn = revenue * (rates.paymentPct / 100) + inputs.volumeMonthly * rates.paymentFixedMxn
  return stack([
    { key: 'hosting', label: 'Hosting', monthlyMxn: hostingMxn },
    { key: 'payment', label: 'Procesamiento de pago', monthlyMxn: paymentMxn },
    { key: 'apps', label: 'Apps premium', monthlyMxn: appsMonthlyMxn },
  ])
}

// ---------------------------------------------------------------------------
// Tiendanube — plan tier (MXN) + either their own gateway (Pago Nube, tier-rated,
// with a fixed fee) or an external gateway (a lower platform cut, no fixed fee
// modeled here — the merchant's own gateway fee is a separate line the caller adds)
// ---------------------------------------------------------------------------

export type TiendanubeTier = 'gratis' | 'basico' | 'tiendanube' | 'avanzado'

export interface TiendanubeRates {
  planMonthlyMxn: Record<TiendanubeTier, number>
  /** Pago Nube (their own gateway) card rate, %, by tier. */
  ownGatewayPct: Record<TiendanubeTier, number>
  /** Pago Nube fixed fee per transaction, MXN (flat across tiers). */
  ownGatewayFixedMxn: number
  /** Platform cut, %, when using an external gateway instead of Pago Nube. */
  externalGatewayPct: Record<TiendanubeTier, number>
}

export function computeTiendanubeCost(
  inputs: ComparatorInputs,
  tier: TiendanubeTier,
  useOwnGateway: boolean,
  rates: TiendanubeRates,
  appsMonthlyMxn = 0,
): StackedCost {
  const revenue = revenueMxn(inputs)
  const planMxn = rates.planMonthlyMxn[tier]
  const gatewayMxn = useOwnGateway
    ? revenue * (rates.ownGatewayPct[tier] / 100) + inputs.volumeMonthly * rates.ownGatewayFixedMxn
    : revenue * (rates.externalGatewayPct[tier] / 100)
  return stack([
    { key: 'plan', label: 'Plan mensual', monthlyMxn: planMxn },
    { key: 'payment', label: useOwnGateway ? 'Pago Nube' : 'Comisión por pasarela externa', monthlyMxn: gatewayMxn },
    { key: 'apps', label: 'Apps premium', monthlyMxn: appsMonthlyMxn },
  ])
}

// ---------------------------------------------------------------------------
// T1 — plan tiers; payments either through T1pagos (% + fixed) or an external
// provider, where T1 takes its own cut (pricing-page A1/A2). Same shape as
// Tiendanube's own-vs-external gateway. T1's free plan has no online store
// («No se puede transaccionar»), so it is not a tier here — modelling it as a
// $0 plan would flatter a plan that cannot sell.
// ---------------------------------------------------------------------------

export type T1Tier = 'basico' | 'avanzado'

export interface T1Rates {
  planMonthlyMxn: Record<T1Tier, number>
  /** T1pagos card rate, % (flat across the paid tiers). */
  t1PagosPct: number
  t1PagosFixedMxn: number
  /** T1's own cut, %, when the merchant uses an external payment provider. */
  externalPct: Record<T1Tier, number>
  /** That external provider's OWN processing fee — T1 charges its cut on top of it. The same
   * public card rate Miyagi's column charges, so the two sides stay like for like. */
  externalProcessorPct: number
  externalProcessorFixedMxn: number
}

export function computeT1Cost(
  inputs: ComparatorInputs,
  tier: T1Tier,
  useT1Pagos: boolean,
  rates: T1Rates,
  appsMonthlyMxn = 0,
): StackedCost {
  const revenue = revenueMxn(inputs)
  const plan = { key: 'plan', label: 'Plan mensual', monthlyMxn: rates.planMonthlyMxn[tier] }
  const apps = { key: 'apps', label: 'Apps premium', monthlyMxn: appsMonthlyMxn }
  if (useT1Pagos) {
    const paymentMxn = revenue * (rates.t1PagosPct / 100) + inputs.volumeMonthly * rates.t1PagosFixedMxn
    return stack([plan, { key: 'payment', label: 'T1pagos', monthlyMxn: paymentMxn }, apps])
  }
  // External provider: T1's cut AND the provider's own fee. Leaving the second out made T1
  // look ~$700/mo cheaper than Miyagi at 100 × $500 while Miyagi's side included processing.
  return stack([
    plan,
    { key: 'payment', label: 'Comisión de T1 por pasarela externa', monthlyMxn: revenue * (rates.externalPct[tier] / 100) },
    {
      key: 'processor',
      label: 'Tu pasarela externa (tarifa pública con tarjeta)',
      monthlyMxn: revenue * (rates.externalProcessorPct / 100) + inputs.volumeMonthly * rates.externalProcessorFixedMxn,
    },
    apps,
  ])
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Miyagi — 0% commission always. SKU costs only (subdomain / custom domain /
// ML-sync, each opt-in), plus the SAME pass-through payment-processor rate a
// self-hosted merchant would pay (Miyagi adds no markup on top of it) — this is
// what makes the Miyagi bar apples-to-apples with the others rather than a bare
// $0 that hides the one real cost every platform shares (card processing).
// ---------------------------------------------------------------------------

export interface MiyagiSkuSelections {
  subdomain: boolean
  customDomain: boolean
  mlSync: boolean
}

export interface MiyagiRates {
  subdomainMonthlyMxn: number
  customDomainMonthlyMxn: number
  mlSyncMonthlyMxn: number
  /** Pass-through processor rate (e.g. Stripe MX) — Miyagi adds no margin on top. */
  paymentPct: number
  paymentFixedMxn: number
}

export function computeMiyagiCost(
  inputs: ComparatorInputs,
  skus: MiyagiSkuSelections,
  rates: MiyagiRates,
): StackedCost {
  const revenue = revenueMxn(inputs)
  const paymentMxn = revenue * (rates.paymentPct / 100) + inputs.volumeMonthly * rates.paymentFixedMxn
  const lines: StackedCostLine[] = [
    { key: 'commission', label: 'Comisión de plataforma (0%)', monthlyMxn: 0 },
    { key: 'payment', label: 'Procesamiento de pago (tu pasarela)', monthlyMxn: paymentMxn },
  ]
  if (skus.subdomain) lines.push({ key: 'subdomain', label: 'Subdominio propio', monthlyMxn: rates.subdomainMonthlyMxn })
  if (skus.customDomain) lines.push({ key: 'customDomain', label: 'Dominio propio', monthlyMxn: rates.customDomainMonthlyMxn })
  if (skus.mlSync) lines.push({ key: 'mlSync', label: 'Sincronización con Mercado Libre', monthlyMxn: rates.mlSyncMonthlyMxn })
  lines.push({ key: 'apps', label: 'Apps premium (incluidas)', monthlyMxn: 0 })
  return stack(lines)
}

// ---------------------------------------------------------------------------
// Premium apps — a competitor's typical bolt-on app cost vs. Miyagi's native,
// already-included equivalent (always $0 on the Miyagi side, by construction).
// ---------------------------------------------------------------------------

export interface PremiumAppOption {
  id: string
  label: string
  monthlyUsd: number
  /** True when Miyagi already includes this natively (the "incluido" mark). */
  miyagiIncluded: boolean
}

/** Sum the monthly MXN cost of the SELECTED competitor apps. */
export function computeSelectedAppsMonthlyMxn(
  apps: PremiumAppOption[],
  selectedIds: readonly string[],
  fxUsdToMxn: number,
): number {
  return round2(
    apps
      .filter((a) => selectedIds.includes(a.id))
      .reduce((sum, a) => sum + a.monthlyUsd * fxUsdToMxn, 0),
  )
}

// ---------------------------------------------------------------------------
// Combos — "marketplace + own site" (e.g. Mercado Libre + Shopify): a merchant
// running both channels pays both stacks. Pure sum, no double-counting logic
// needed since the two stacks model independent channels.
// ---------------------------------------------------------------------------

export function combineStacks(...stacks: StackedCost[]): StackedCost {
  const lines = stacks.flatMap((s, i) =>
    s.lines.map((l) => ({ ...l, key: `${i}.${l.key}` })),
  )
  return stack(lines)
}

// ---------------------------------------------------------------------------
// Inline overrides (US-1.3) — the visitor can edit any rendered line's monthly
// MXN amount directly; this recomputes totals from the edited lines. Pure and
// keyed by `line.key`, so the caller decides what scope an override key means
// (e.g. namespacing it by platform+tier when storing it in UI state).
// ---------------------------------------------------------------------------

export function applyLineOverrides(result: StackedCost, overrides: Readonly<Record<string, number>>): StackedCost {
  const lines = result.lines.map((l) =>
    Number.isFinite(overrides[l.key]) ? { ...l, monthlyMxn: overrides[l.key] } : l,
  )
  return stack(lines)
}

/** es-MX currency formatting — the single source both the UI and its specs use, so
 * a displayed figure and a spec's expected string can never drift on rounding. */
export function formatMxn(n: number): string {
  return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(n)
}
