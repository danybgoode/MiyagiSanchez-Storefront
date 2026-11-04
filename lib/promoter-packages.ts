/**
 * The promoter's three packages (epic 08 · plans-gratis-negocio S4, README D12, D13; Daniel, 2026-11-04).
 *
 * The deal a promoter says in one sentence: "you charge X, you pay us Y, you keep Z".
 *   - Anual     — setup + 12 months of Negocio: charge 2,000, pay 900, keep 1,100 (55%).
 *   - Arranque  — setup + 3 months of Negocio:  charge 600,   pay 300, keep 300   (50%).
 *   - Gratis    — setup on the free plan:        charge 250,   pay 50,  keep 200   (80%).
 *
 * The LIST PRICE is the package's own (never Negocio's price: the promoter-price clamp would cut 2,000 to 1,490), and
 * the share comes from the commission rates in `marketplace_promoter_commission_rates` (seeded by M1, editable in
 * /admin/promoter). Both payment paths are SETTLED AT SOURCE (amendment to D12, recorded in the epic): the promoter
 * collects the price in person and sends the platform only its share — by SPEI/DiMo/CoDi, or by card for exactly that
 * amount — so no commission accrues for a package.
 *
 * The year-2 renewal (D13): a Negocio payment 12–24 months after a promoter's FIRST Negocio package payment for that
 * shop accrues `negocio_renewal` (10%) for that promoter.
 *
 * Pure + next-free: the rate card, the close routes, the webhook and the specs read the same numbers.
 */
import { computeCommissionCents } from './promoter-commission'

export const PACKAGE_SKUS = ['negocio_anual', 'negocio_arranque', 'setup_gratis'] as const
export type PackageSku = (typeof PACKAGE_SKUS)[number]
export const RENEWAL_SKU = 'negocio_renewal' as const

export function isPackageSku(raw: unknown): raw is PackageSku {
  return typeof raw === 'string' && (PACKAGE_SKUS as readonly string[]).includes(raw)
}

export type PackageDef = { priceMxn: number; negocioMonths: number; label: string; summary: string }

/** The packages' list prices and what each grants. Prices are Daniel's (2026-11-04); the split is the rate. */
export const PACKAGES: Readonly<Record<PackageSku, PackageDef>> = Object.freeze({
  negocio_anual: { priceMxn: 2000, negocioMonths: 12, label: 'Paquete Anual', summary: 'Instalación + 12 meses de Negocio' },
  negocio_arranque: { priceMxn: 600, negocioMonths: 3, label: 'Paquete Arranque', summary: 'Instalación + 3 meses de Negocio' },
  setup_gratis: { priceMxn: 250, negocioMonths: 0, label: 'Instalación Gratis', summary: 'Instalación en el plan Gratis' },
})

export type PackageSplit = { chargeCents: number; keepCents: number; payPlatformCents: number }

/** Charge = the list price; keep = the promoter's rate of it; pay = the rest (never negative). */
export function packageSplit(sku: PackageSku, ratePct: number): PackageSplit {
  const chargeCents = PACKAGES[sku].priceMxn * 100
  const keepCents = computeCommissionCents(ratePct, chargeCents)
  return { chargeCents, keepCents, payPlatformCents: Math.max(0, chargeCents - keepCents) }
}

const pesos = (cents: number) => '$' + Math.round(cents / 100).toLocaleString('en-US')

/** "Cobras $2,000 · nos pagas $900 · te quedas $1,100". */
export function packageSentence(sku: PackageSku, ratePct: number): string {
  const s = packageSplit(sku, ratePct)
  return `Cobras ${pesos(s.chargeCents)} · nos pagas ${pesos(s.payPlatformCents)} · te quedas ${pesos(s.keepCents)}`
}

/** The renewal window after the first Negocio package payment: months [12, 24). */
export const RENEWAL_WINDOW_MONTHS = { from: 12, to: 24 } as const

/**
 * Does a Negocio payment at `paidAt` earn the promoter the renewal share? Only between 12 and 24 months after the
 * promoter's first Negocio package payment for that shop (Daniel: "10% of a merchant's year-2 renewal").
 */
export function isRenewalPayment(firstPackagePaidAt: Date, paidAt: Date): boolean {
  const from = new Date(firstPackagePaidAt)
  from.setUTCMonth(from.getUTCMonth() + RENEWAL_WINDOW_MONTHS.from)
  const to = new Date(firstPackagePaidAt)
  to.setUTCMonth(to.getUTCMonth() + RENEWAL_WINDOW_MONTHS.to)
  return paidAt.getTime() >= from.getTime() && paidAt.getTime() < to.getTime()
}

/** Only the Negocio packages open a renewal window (the free setup sold no Negocio to renew). */
export function startsRenewalWindow(sku: string | null): boolean {
  return sku === 'negocio_anual' || sku === 'negocio_arranque'
}
