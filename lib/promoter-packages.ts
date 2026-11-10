/**
 * The promoter's packages (epic 08 · plan-tienda-three-free-months S4, README D11, D12, D14; first built in
 * plans-gratis-negocio S4).
 *
 * The deal a promoter says in one sentence: "you charge X, you pass us Y, you keep Z". Three packages are sold, each
 * with three free months of Plan Negocio ON TOP of the paid time, all dated from the payment day (D11):
 *   - Tienda · 1 año    — charge 500,   rate 60 → pass 200, keep 300.   Negocio 3 months, then Tienda 12.
 *   - Negocio · 6 meses — charge 1,100, rate 55 → pass 495, keep 605.   Negocio 9 months (3 + 6).
 *   - Negocio · 1 año   — charge 2,000, rate 55 → pass 900, keep 1,100. Negocio 15 months (3 + 12).
 * The six-month split is 495 / 605, not 500 / 600: the rate column is an integer and 600 of 1,100 is 54.54% (D12,
 * Daniel 2026-11-10).
 *
 * `negocio_arranque` and `setup_gratis` are RETIRED (D11): their sale is refused, but they stay in this vocabulary so
 * every old transfer, attribution, receipt and admin row still reads with its label (rabbit hole «retired packages
 * stay in the vocabulary»). A pending transfer for one of them can still be approved: the money was already taken.
 *
 * The LIST PRICE is the package's own, and the share comes from `marketplace_promoter_commission_rates` (editable in
 * /admin/promoter). Both payment paths are SETTLED AT SOURCE: the promoter collects the price in person and sends the
 * platform only its share, so no commission accrues for a package.
 *
 * After the sale the promoter earns again (D14), each share recorded once:
 *   - `negocio_renewal` 10% — a Negocio payment in months [12, 24) after the first Negocio package for that shop;
 *   - `tienda_renewal`  10% — a Tienda payment in months [12, 24) after the first package for that shop;
 *   - `negocio_upgrade` 20% — the FIRST Negocio payment within 12 months of a `tienda_anual` for that shop.
 *
 * Pure + next-free: the rate card, the close routes, the webhook and the specs read the same numbers.
 */
import { computeCommissionCents } from './promoter-commission'

/** Every package that was ever sold — the vocabulary every READ uses. */
export const PACKAGE_SKUS = ['tienda_anual', 'negocio_semestral', 'negocio_anual', 'negocio_arranque', 'setup_gratis'] as const
export type PackageSku = (typeof PACKAGE_SKUS)[number]

/** No longer sold (D11). A sale answers 410; reads, receipts and pending-transfer approvals still work. */
export const RETIRED_PACKAGE_SKUS = ['negocio_arranque', 'setup_gratis'] as const satisfies readonly PackageSku[]
export type RetiredPackageSku = (typeof RETIRED_PACKAGE_SKUS)[number]

/** The three packages on sale, in the order every page shows them. */
export const SELLABLE_PACKAGE_SKUS = ['tienda_anual', 'negocio_semestral', 'negocio_anual'] as const satisfies readonly PackageSku[]
export type SellablePackageSku = (typeof SELLABLE_PACKAGE_SKUS)[number]

export const RENEWAL_SKU = 'negocio_renewal' as const
export const TIENDA_RENEWAL_SKU = 'tienda_renewal' as const
export const UPGRADE_SKU = 'negocio_upgrade' as const
/** The shares a promoter earns after the sale. Recorded only by the server when the merchant pays. */
export const SHARE_SKUS = [RENEWAL_SKU, TIENDA_RENEWAL_SKU, UPGRADE_SKU] as const
export type ShareSku = (typeof SHARE_SKUS)[number]
export type RenewalSku = typeof RENEWAL_SKU | typeof TIENDA_RENEWAL_SKU

export function isPackageSku(raw: unknown): raw is PackageSku {
  return typeof raw === 'string' && (PACKAGE_SKUS as readonly string[]).includes(raw)
}

export function isRetiredPackageSku(raw: unknown): raw is RetiredPackageSku {
  return typeof raw === 'string' && (RETIRED_PACKAGE_SKUS as readonly string[]).includes(raw)
}

export function isSellablePackageSku(raw: unknown): raw is SellablePackageSku {
  return typeof raw === 'string' && (SELLABLE_PACKAGE_SKUS as readonly string[]).includes(raw)
}

export function isShareSku(raw: unknown): raw is ShareSku {
  return typeof raw === 'string' && (SHARE_SKUS as readonly string[]).includes(raw)
}

/** The plain refusal a retired package's sale answers (410). */
export const RETIRED_PACKAGE_MESSAGE = 'Este paquete ya no se vende. Elige Plan Tienda · 1 año, Plan Negocio · 6 meses o Plan Negocio · 1 año.'

/** The free months of Plan Negocio every package on sale includes on top of its paid time (D11). */
export const PACKAGE_FREE_MONTHS = 3

/** One dated grant a package writes: `months` of `plan`, from the payment day. */
export type PackageGrant = { plan: 'negocio' | 'tienda'; months: number }

export type PackageDef = {
  priceMxn: number
  /** Written in this order, each dated from the payment day (Tienda's start waits for the Negocio grant's end). */
  grants: readonly PackageGrant[]
  label: string
  summary: string
}

/** The packages' list prices and what each grants. Prices are Daniel's; the split is the rate. */
export const PACKAGES: Readonly<Record<PackageSku, PackageDef>> = Object.freeze({
  tienda_anual: {
    priceMxn: 500,
    grants: [{ plan: 'negocio', months: 3 }, { plan: 'tienda', months: 12 }],
    label: 'Plan Tienda · 1 año',
    summary: 'Le armas su tienda: 3 meses de Plan Negocio gratis y después 12 meses de Plan Tienda',
  },
  negocio_semestral: {
    priceMxn: 1100,
    grants: [{ plan: 'negocio', months: 9 }],
    label: 'Plan Negocio · 6 meses',
    summary: 'Le armas su tienda: 3 meses de Plan Negocio gratis y después 6 meses más',
  },
  negocio_anual: {
    priceMxn: 2000,
    // 15, not 12: the three free months are on top (D11). The one pending `negocio_anual` transfer of 2026-11-09, if
    // approved after this deploys, grants 15 months too (see lib/promoter-grant-server.ts).
    grants: [{ plan: 'negocio', months: 15 }],
    label: 'Plan Negocio · 1 año',
    summary: 'Le armas su tienda: 3 meses de Plan Negocio gratis y después 12 meses más',
  },
  // Retired (D11): kept with their ORIGINAL grants, because a transfer created before the deploy may still be approved.
  negocio_arranque: { priceMxn: 600, grants: [{ plan: 'negocio', months: 3 }], label: 'Plan Negocio · 3 meses', summary: 'Le armas su tienda y tiene el Plan Negocio 3 meses' },
  setup_gratis: { priceMxn: 250, grants: [], label: 'Plan Gratis · tienda lista', summary: 'Le armas su tienda en el Plan Gratis, sin mensualidad' },
})

/** How many months of `plan` a package grants in total (0 when none). */
export function packageMonths(sku: PackageSku, plan: PackageGrant['plan']): number {
  return PACKAGES[sku].grants.filter((g) => g.plan === plan).reduce((n, g) => n + g.months, 0)
}

export type PackageSplit = { chargeCents: number; keepCents: number; payPlatformCents: number }

/** Charge = the list price; keep = the promoter's rate of it; pay = the rest (never negative). */
export function packageSplit(sku: PackageSku, ratePct: number): PackageSplit {
  const chargeCents = PACKAGES[sku].priceMxn * 100
  const keepCents = computeCommissionCents(ratePct, chargeCents)
  return { chargeCents, keepCents, payPlatformCents: Math.max(0, chargeCents - keepCents) }
}

const pesos = (cents: number) => '$' + Math.round(cents / 100).toLocaleString('en-US')

/** "Cobras $2,000. Le pasas $900 a Miyagi Sánchez. Te quedas $1,100" — the money first, always in this order. */
export function packageSentence(sku: PackageSku, ratePct: number): string {
  const s = packageSplit(sku, ratePct)
  return `Cobras ${pesos(s.chargeCents)}. Le pasas ${pesos(s.payPlatformCents)} a Miyagi Sánchez. Te quedas ${pesos(s.keepCents)}`
}

// ── Writing a package's grants (D11) ──────────────────────────────────────────

export type PackageGrantOutcome = 'written' | 'replay' | 'comp'

export type PackageGrantInput = { shopId: string; paymentId: string; months: number; note: string; now?: Date; ignoreTrial: true }

export type PackageGrantDeps = {
  /** Write `months` of `plan` through the plan seam (`applyNegocioPayment` / `applyTiendaPayment`): replay-safe on
   *  `paymentId`, guarded on every key read. Throws when the write could not be made. */
  apply: (plan: PackageGrant['plan'], input: PackageGrantInput) => Promise<PackageGrantOutcome>
}

/**
 * Write every grant of a package, in order, all under the SAME payment id.
 *
 * Why this is safe against a crash between the two writes of `tienda_anual`: each grant remembers the payment ids it
 * counted (`payments`), and the decision answers `replay` for an id already there. So a retry of the same payment (a
 * re-sent webhook, a re-approved transfer after its claim was released) finds the Negocio half already counted and
 * writes nothing there, then writes the missing Tienda half — and a full replay repeats nothing at all. The two
 * writes land on the same final dates in either order (the Tienda months wait for a live dated Negocio grant, and a
 * Negocio write moves a live Tienda grant forward, D4), so the order is a choice, not a correctness condition.
 *
 * Outcome: `written` if ANY grant was written by this call (the first delivery, or a retry that completed a missing
 * half — either way the sale is whole for the first time now, so the receipt and the attribution follow); `replay`
 * if every grant was already counted; `comp` if the shop holds a permanent Negocio — nothing further is written, so
 * Tienda months are never spent underneath a Negocio that never ends (the caller alerts for a refund); `none` for a
 * package that grants nothing (the retired free setup).
 */
/**
 * The instant a payment happened, from the Stripe event's own `created` (seconds). A Checkout Session carries no
 * completion time of its own, so the `checkout.session.completed` event's `created` is the payment's moment; Stripe
 * redelivers the SAME event, so every delivery — an hour or a day later — dates the grants identically (Codex,
 * PR 486: dating them when the webhook RUNS starts the paid term late on a delayed or retried event). Undefined only
 * when no event time was given, and then the plan seam falls back to now.
 */
export function paymentInstant(eventCreatedSec: number | undefined): Date | undefined {
  return typeof eventCreatedSec === 'number' && Number.isFinite(eventCreatedSec) && eventCreatedSec > 0 ? new Date(eventCreatedSec * 1000) : undefined
}

/** What `applyPackageGrants` is asked for a card payment: the session id as the replay key, dated from the event. */
export function packageGrantRequest(input: { sku: PackageSku; shopId: string; sessionId: string; eventCreatedSec?: number }): {
  sku: PackageSku
  shopId: string
  paymentId: string
  now?: Date
} {
  const now = paymentInstant(input.eventCreatedSec)
  return { sku: input.sku, shopId: input.shopId, paymentId: input.sessionId, ...(now ? { now } : {}) }
}

export async function applyPackageGrants(
  input: { sku: PackageSku; shopId: string; paymentId: string; now?: Date },
  deps: PackageGrantDeps,
): Promise<PackageGrantOutcome | 'none'> {
  const grants = PACKAGES[input.sku].grants
  if (grants.length === 0) return 'none'
  let wrote = false
  for (const grant of grants) {
    const outcome = await deps.apply(grant.plan, {
      shopId: input.shopId,
      paymentId: input.paymentId,
      months: grant.months,
      note: `promoter ${input.sku}`,
      ...(input.now ? { now: input.now } : {}),
      ignoreTrial: true,
    })
    if (outcome === 'comp') return 'comp'
    if (outcome === 'written') wrote = true
  }
  return wrote ? 'written' : 'replay'
}

// ── The shares after the sale (D14) ───────────────────────────────────────────

/** `n` calendar months after `from`, in UTC (the renewal window's original arithmetic, kept so old windows hold). */
function monthsAfter(from: Date, n: number): Date {
  const d = new Date(from)
  d.setUTCMonth(d.getUTCMonth() + n)
  return d
}

/** True when `paidAt` falls in months [from, to) after `anchor`. */
export function isWithinMonths(anchor: Date, paidAt: Date, from: number, to: number): boolean {
  return paidAt.getTime() >= monthsAfter(anchor, from).getTime() && paidAt.getTime() < monthsAfter(anchor, to).getTime()
}

/** The renewal window after the first package payment: months [12, 24). */
export const RENEWAL_WINDOW_MONTHS = { from: 12, to: 24 } as const

/** The upgrade window after a `tienda_anual` payment: months [0, 12). */
export const UPGRADE_WINDOW_MONTHS = { from: 0, to: 12 } as const

/** Does a payment at `paidAt` earn a renewal share? Only in months [12, 24) after the anchoring package payment. */
export function isRenewalPayment(firstPackagePaidAt: Date, paidAt: Date): boolean {
  return isWithinMonths(firstPackagePaidAt, paidAt, RENEWAL_WINDOW_MONTHS.from, RENEWAL_WINDOW_MONTHS.to)
}

/**
 * Which package payments open each renewal window. A renewal renews something that was sold:
 *   - `negocio_renewal`: the Negocio packages (`negocio_semestral` joins the two from plans-gratis-negocio). A
 *     `tienda_anual` does not open it: its Negocio months were free, so a later Negocio payment there is an upgrade
 *     (20%, in its first year) and not a renewal.
 *   - `tienda_renewal`: every package that granted a paid plan — a Tienda payment in year 2 renews the shop the
 *     promoter opened, whichever package opened it. `setup_gratis` sold no plan, so it opens neither.
 */
export const RENEWAL_ANCHOR_SKUS: Readonly<Record<RenewalSku, readonly PackageSku[]>> = Object.freeze({
  negocio_renewal: ['negocio_anual', 'negocio_arranque', 'negocio_semestral'],
  tienda_renewal: ['tienda_anual', 'negocio_semestral', 'negocio_anual', 'negocio_arranque'],
})

/** Does a package payment of `sku` open the `renewalSku` window? */
export function startsRenewalWindow(sku: string | null, renewalSku: RenewalSku = RENEWAL_SKU): boolean {
  return !!sku && (RENEWAL_ANCHOR_SKUS[renewalSku] as readonly string[]).includes(sku)
}

export type RenewalDecision = { action: 'record' } | { action: 'skip'; reason: 'not_attributed' | 'outside_window' }

/**
 * A renewal share (D14): given the EARLIEST paid package for this shop among those that open `renewalSku`'s window
 * (`RENEWAL_ANCHOR_SKUS`), does a payment at `paidAt` earn that package's promoter the share? Only in months
 * [12, 24) after it. Pure; the caller reads the anchor. Once per payment is the caller's `payment_ref` (unique).
 */
export function decideRenewalShare(input: {
  renewalSku: RenewalSku
  anchor: { sku: string | null; paidAt: Date } | null
  paidAt: Date
}): RenewalDecision {
  if (!input.anchor || !startsRenewalWindow(input.anchor.sku, input.renewalSku)) return { action: 'skip', reason: 'not_attributed' }
  if (!isRenewalPayment(input.anchor.paidAt, input.paidAt)) return { action: 'skip', reason: 'outside_window' }
  return { action: 'record' }
}

/** The Negocio packages: a sale of one after a `tienda_anual` supersedes the upgrade share. */
export const NEGOCIO_PACKAGE_SKUS: readonly PackageSku[] = PACKAGE_SKUS.filter(
  (sku) => packageMonths(sku, 'negocio') > 0 && packageMonths(sku, 'tienda') === 0,
)

export type UpgradeDecision =
  | { action: 'record'; paymentRef: string }
  | { action: 'skip'; reason: 'no_anchor' | 'outside_window' | 'superseded' }

/**
 * `negocio_upgrade` (D14): does this merchant Negocio payment earn the promoter who sold the shop's latest
 * `tienda_anual` 20%? Pure; the caller reads the anchor and whether a Negocio package was sold after it.
 *
 *   - no `tienda_anual` paid for this shop → skip;
 *   - the payment is outside months [0, 12) of that package → skip;
 *   - a Negocio PACKAGE was sold for this shop after the `tienda_anual` → skip: the move up already happened, and
 *     the promoter who sold it kept their package share, so a later merchant payment is not the first Negocio
 *     payment and earns nothing under this rule;
 *   - otherwise → record, under a payment_ref keyed by the ANCHOR, not by the payment: the unique `payment_ref`
 *     index then admits exactly one upgrade per `tienda_anual`, so a second Negocio payment (or two arriving at once)
 *     collides and adds nothing. "First payment only" is held by the database, not by a read that can race.
 */
export function decideUpgradeShare(input: {
  anchor: { attributionId: string; paidAt: Date } | null
  paidAt: Date
  negocioPackageAfterAnchor: boolean
}): UpgradeDecision {
  if (!input.anchor) return { action: 'skip', reason: 'no_anchor' }
  if (!isWithinMonths(input.anchor.paidAt, input.paidAt, UPGRADE_WINDOW_MONTHS.from, UPGRADE_WINDOW_MONTHS.to)) {
    return { action: 'skip', reason: 'outside_window' }
  }
  if (input.negocioPackageAfterAnchor) return { action: 'skip', reason: 'superseded' }
  return { action: 'record', paymentRef: upgradePaymentRef(input.anchor.attributionId) }
}

/** The one payment_ref an upgrade share can ever have for a given `tienda_anual` attribution. */
export function upgradePaymentRef(anchorAttributionId: string): string {
  return `${UPGRADE_SKU}:${anchorAttributionId}`
}
