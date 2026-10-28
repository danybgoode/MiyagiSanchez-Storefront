/**
 * lib/pricing-catalog.ts
 *
 * The ONE pricing catalog (epic 08 · pricing-page, S1.1 — README D1–D5, D7). Every surface
 * that states what Miyagi costs — `/mx/precios`, `/acerca` (es + en), the agent about
 * surfaces and `llms.txt` — reads its numbers from here, so a price changed in its own
 * module reaches all of them. Before this, `/acerca` re-typed "$199 MXN/año" by hand in two
 * places that had already drifted apart, and agents were told premium services were
 * "priced TBD".
 *
 * Pure + next-free + DB-free → unit-testable by the Playwright `api` runner. Fixed prices are
 * IMPORTED from their single-source modules, never restated here. The two admin-set prices
 * (migration, print ad) and the processor rates arrive as INPUT — the I/O shell
 * (`lib/pricing-catalog-server.ts`) reads them — so this module stays a pure function.
 *
 * An unset admin price is `null`, and `null` renders «Precio a cotizar», never `$0`: a "$0"
 * on a price page reads as "free", which is a promise nobody made.
 */

import {
  SUBDOMAIN_PRICE_YEARLY_MXN,
  SUBDOMAIN_PRICE_MONTHLY_MXN,
} from './subdomain-pricing'
import { CUSTOM_DOMAIN_PRICE_MXN } from './domain-pricing'
import { ML_SYNC_PRICE_YEARLY_MXN, ML_SYNC_PRICE_MONTHLY_MXN } from './ml-sync-pricing'
import { MIGRATION_FLAT_LISTING_CAP } from './migration-estimate'
import { PROMOTER_SKUS, type PromoterSku } from './promoter-skus'

export type PricingLocale = 'es' | 'en'
export type Localized = Record<PricingLocale, string>

/** One processor's published rate, read from the comparador dataset (README D5). */
export interface ProcessorRate {
  pct: number
  fixedMxn: number
  source: string
  verifiedAt: string
}

export interface PricingCatalogInput {
  /** Admin-set migration price, whole MXN (`getPromoterSkuPrices().migration`). `null` = unset. */
  migrationPriceMxn: number | null
  /** `price_cents` of every tier of every OPEN print edition. `null`/empty = none on sale. */
  printAdTiersCents: readonly number[] | null
  processors: { stripe: ProcessorRate; mercadopago: ProcessorRate }
}

export interface FreeItem {
  id: string
  title: Localized
  body: Localized
  icon: string
}

export interface ExtraRow {
  sku: PromoterSku
  /** `fixed` = a constant in its own module; `admin` = set in admin, may be unset. */
  kind: 'fixed' | 'admin'
  name: Localized
  description: Localized
  /** Yearly price, MXN. `null` when the SKU has no yearly cadence or is unset. */
  yearlyMxn: number | null
  /** Purchasable monthly price, MXN. `null` when there is no monthly purchase (D4). */
  monthlyMxn: number | null
  /** One-off price (migration) or "desde" price (print ad), MXN. `null` = unset ⇒ «Precio a cotizar». */
  oneOffMxn: number | null
  /** The display price, formatted from the numbers above. */
  priceLabel: Localized
  /** True when nothing is priced yet — the page shows «Precio a cotizar» + a contact path. */
  quoted: boolean
}

export interface ProcessorRow {
  id: 'stripe' | 'mercadopago' | 'spei'
  name: string
  /** `null` for SPEI — Miyagi does not process it, so there is no rate to state (D5). */
  pct: number | null
  fixedMxn: number | null
  rateLabel: Localized
  note: Localized
  source: string | null
  verifiedAt: string | null
}

export interface PricingCatalog {
  free: FreeItem[]
  extras: ExtraRow[]
  processors: ProcessorRow[]
}

// ── Formatting ─────────────────────────────────────────────────────────────────

/** `$1,499` — whole pesos, es-MX grouping (also correct for the en copy: MXN amounts). */
export function formatPesos(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`
}

/** `3.49%` / `3.6%` — no trailing zeros. */
function formatPct(n: number): string {
  return `${Number(n.toFixed(2))}%`
}

/** The yearly price as a monthly equivalent, rounded to whole pesos (199 → 17, 499 → 42, 299 → 25). */
export function yearlyAsMonthly(yearlyMxn: number): number {
  return Math.round(yearlyMxn / 12)
}

const QUOTED: Localized = { es: 'Precio a cotizar', en: 'Price on request' }

function yearlyLabel(yearly: number, monthly: number | null): Localized {
  const eq = yearlyAsMonthly(yearly)
  if (monthly == null) {
    return {
      es: `${formatPesos(yearly)} MXN/año (~${formatPesos(eq)}/mes)`,
      en: `${formatPesos(yearly)} MXN/year (~${formatPesos(eq)}/mo)`,
    }
  }
  return {
    es: `${formatPesos(yearly)} MXN/año (~${formatPesos(eq)}/mes) o ${formatPesos(monthly)} MXN/mes`,
    en: `${formatPesos(yearly)} MXN/year (~${formatPesos(eq)}/mo) or ${formatPesos(monthly)} MXN/mo`,
  }
}

// ── Rows ───────────────────────────────────────────────────────────────────────

const FREE_ITEMS: FreeItem[] = [
  {
    id: 'shop',
    icon: 'iconoir-shop',
    title: { es: 'Tu tienda y su URL', en: 'Your shop and its URL' },
    body: {
      es: 'Tu tienda en miyagisanchez.com/mx/s/tu-tienda, sin costo y sin caducidad.',
      en: 'Your shop at miyagisanchez.com/mx/s/your-shop, free and with no expiry.',
    },
  },
  {
    id: 'commission',
    icon: 'iconoir-percentage-circle',
    title: { es: '0% de comisión de la plataforma', en: '0% platform commission' },
    body: {
      es: 'No nos quedamos con un porcentaje de tus ventas.',
      en: 'We take no cut of your sales.',
    },
  },
  {
    id: 'publish',
    icon: 'iconoir-upload',
    title: { es: 'Publicar tus productos', en: 'Publishing your products' },
    body: {
      es: 'Sube tu catálogo y la IA lo ordena; publicar no cuesta.',
      en: 'Upload your catalog and the AI structures it; publishing costs nothing.',
    },
  },
  {
    id: 'marketplace',
    icon: 'iconoir-search',
    title: { es: 'Aparecer en el marketplace', en: 'Appearing in the marketplace' },
    body: {
      es: 'Tus productos salen en la búsqueda de Miyagi Sánchez.',
      en: 'Your products show up in Miyagi Sánchez search.',
    },
  },
  {
    id: 'messages',
    icon: 'iconoir-chat-bubble',
    title: { es: 'Ofertas y mensajes', en: 'Offers and messages' },
    body: {
      es: 'Negocia y platica con tus compradores dentro de la plataforma.',
      en: 'Negotiate and chat with your buyers on the platform.',
    },
  },
  {
    id: 'agents',
    icon: 'iconoir-sparks',
    title: { es: 'Agentes de IA', en: 'AI agents' },
    body: {
      es: 'Tu tienda habla con los asistentes de IA (UCP/MCP) sin pagar extra.',
      en: 'Your shop talks to AI assistants (UCP/MCP) at no extra cost.',
    },
  },
  {
    id: 'delivery',
    icon: 'iconoir-delivery-truck',
    title: { es: 'Entrega acordada', en: 'Arranged delivery' },
    body: {
      es: 'Acuerda la entrega con tu comprador sin pagar paquetería.',
      en: 'Arrange delivery with your buyer without paying a carrier.',
    },
  },
]

function extraRows(input: PricingCatalogInput): ExtraRow[] {
  const printFrom =
    input.printAdTiersCents && input.printAdTiersCents.length > 0
      ? Math.min(...input.printAdTiersCents.filter((c) => Number.isFinite(c) && c >= 100)) / 100
      : null
  // Sub-peso tiers are dropped (they would round to a rendered «$0»); an open edition whose
  // tiers are all 0/invalid makes Math.min() Infinity — treat as unset.
  const printFromMxn = printFrom != null && Number.isFinite(printFrom) ? printFrom : null
  const migration =
    input.migrationPriceMxn != null && Number.isFinite(input.migrationPriceMxn) && input.migrationPriceMxn > 0
      ? input.migrationPriceMxn
      : null

  const rows: Record<PromoterSku, ExtraRow> = {
    subdomain: {
      sku: 'subdomain',
      kind: 'fixed',
      name: { es: 'Subdominio propio', en: 'Custom subdomain' },
      description: {
        es: 'Tu tienda como sitio independiente en tu-tienda.miyagisanchez.com, sin la barra de la plataforma.',
        en: 'Your shop as a standalone site at your-shop.miyagisanchez.com, without the platform bar.',
      },
      yearlyMxn: SUBDOMAIN_PRICE_YEARLY_MXN,
      monthlyMxn: SUBDOMAIN_PRICE_MONTHLY_MXN,
      oneOffMxn: null,
      priceLabel: yearlyLabel(SUBDOMAIN_PRICE_YEARLY_MXN, SUBDOMAIN_PRICE_MONTHLY_MXN),
      quoted: false,
    },
    custom_domain: {
      sku: 'custom_domain',
      kind: 'fixed',
      name: { es: 'Dominio propio', en: 'Custom domain' },
      description: {
        es: 'Conecta tu dominio (tutienda.com) con SSL incluido, sin miyagisanchez.com en la URL.',
        en: 'Connect your own domain (yourshop.com) with SSL included, with no miyagisanchez.com in the URL.',
      },
      // Yearly-only SKU (README D4): the ~$/mes is an equivalent, not a monthly purchase.
      yearlyMxn: CUSTOM_DOMAIN_PRICE_MXN,
      monthlyMxn: null,
      oneOffMxn: null,
      priceLabel: yearlyLabel(CUSTOM_DOMAIN_PRICE_MXN, null),
      quoted: false,
    },
    ml_sync: {
      sku: 'ml_sync',
      kind: 'fixed',
      name: { es: 'Sincronizar con Mercado Libre', en: 'Mercado Libre sync' },
      description: {
        es: 'Inventario sincronizado en dos sentidos con Mercado Libre. Conectar, importar y publicar siguen gratis.',
        en: 'Two-way inventory sync with Mercado Libre. Connecting, importing and publishing stay free.',
      },
      yearlyMxn: ML_SYNC_PRICE_YEARLY_MXN,
      monthlyMxn: ML_SYNC_PRICE_MONTHLY_MXN,
      oneOffMxn: null,
      priceLabel: yearlyLabel(ML_SYNC_PRICE_YEARLY_MXN, ML_SYNC_PRICE_MONTHLY_MXN),
      quoted: false,
    },
    print_ad: {
      sku: 'print_ad',
      kind: 'admin',
      name: { es: 'Anuncio impreso', en: 'Print ad' },
      description: {
        es: 'Tu anuncio en la edición impresa de Miyagi Sánchez, por tamaño de espacio.',
        en: 'Your ad in the Miyagi Sánchez print edition, priced by ad size.',
      },
      yearlyMxn: null,
      monthlyMxn: null,
      oneOffMxn: printFromMxn,
      priceLabel:
        printFromMxn != null
          ? { es: `Desde ${formatPesos(printFromMxn)} MXN por edición`, en: `From ${formatPesos(printFromMxn)} MXN per edition` }
          : QUOTED,
      quoted: printFromMxn == null,
    },
    migration: {
      sku: 'migration',
      kind: 'admin',
      name: { es: 'Migración con consultor', en: 'Assisted migration' },
      description: {
        es: `Un consultor pasa tu tienda de otra plataforma a Miyagi Sánchez (hasta ${MIGRATION_FLAT_LISTING_CAP} productos; más, a cotizar).`,
        en: `A consultant moves your shop from another platform to Miyagi Sánchez (up to ${MIGRATION_FLAT_LISTING_CAP} products; more on request).`,
      },
      yearlyMxn: null,
      monthlyMxn: null,
      oneOffMxn: migration,
      priceLabel:
        migration != null
          ? { es: `${formatPesos(migration)} MXN, pago único`, en: `${formatPesos(migration)} MXN, one-off` }
          : QUOTED,
      quoted: migration == null,
    },
  }
  // PROMOTER_SKUS order, so a new SKU added there without a row here fails to typecheck (Record)
  // AND the completeness spec (README D3).
  return PROMOTER_SKUS.map((sku) => rows[sku])
}

function processorRows(input: PricingCatalogInput): ProcessorRow[] {
  const { stripe, mercadopago } = input.processors
  const rate = (r: ProcessorRate): Localized => ({
    es: `${formatPct(r.pct)} + ${formatPesos(r.fixedMxn)} MXN por venta, más IVA`,
    en: `${formatPct(r.pct)} + ${formatPesos(r.fixedMxn)} MXN per sale, plus VAT`,
  })
  return [
    {
      id: 'stripe',
      name: 'Stripe',
      pct: stripe.pct,
      fixedMxn: stripe.fixedMxn,
      rateLabel: rate(stripe),
      note: {
        es: 'Pagos con tarjeta. El dinero llega a tu propia cuenta de Stripe.',
        en: 'Card payments. The money lands in your own Stripe account.',
      },
      source: stripe.source,
      verifiedAt: stripe.verifiedAt,
    },
    {
      id: 'mercadopago',
      name: 'Mercado Pago',
      pct: mercadopago.pct,
      fixedMxn: mercadopago.fixedMxn,
      rateLabel: rate(mercadopago),
      note: {
        es: 'Tarjeta, saldo y más, con el dinero al instante en tu cuenta de Mercado Pago.',
        en: 'Cards, balance and more, with the money instantly in your Mercado Pago account.',
      },
      source: mercadopago.source,
      verifiedAt: mercadopago.verifiedAt,
    },
    {
      id: 'spei',
      name: 'SPEI',
      pct: null,
      fixedMxn: null,
      rateLabel: { es: 'Miyagi Sánchez no cobra nada', en: 'Miyagi Sánchez charges nothing' },
      note: {
        es: 'Tu comprador te transfiere directo a tu CLABE. Tu banco puede cobrar su propia comisión.',
        en: 'Your buyer transfers straight to your CLABE. Your bank may charge its own fee.',
      },
      source: null,
      verifiedAt: null,
    },
  ]
}

/** Assemble the full catalog. Pure: same input ⇒ same output. */
export function buildPricingCatalog(input: PricingCatalogInput): PricingCatalog {
  return { free: FREE_ITEMS, extras: extraRows(input), processors: processorRows(input) }
}

export function getExtra(catalog: PricingCatalog, sku: PromoterSku): ExtraRow {
  const row = catalog.extras.find((r) => r.sku === sku)
  // Unreachable while extraRows maps PROMOTER_SKUS — kept so a broken invariant fails loudly.
  if (!row) throw new Error(`pricing-catalog: no row for ${sku}`)
  return row
}

// ── Token filling (README D7) ──────────────────────────────────────────────────

/**
 * The `{token}`s copy may use instead of a typed price. Locale strings and admin overrides
 * hold the token; this fills it from the catalog at render time. The source-sweep spec
 * (`e2e/pricing-source-sweep.spec.ts`) fails on a typed MXN price in the swept copy, so a
 * token is the only way a price gets into it.
 */

/** Tokens for the fixed-price SKUs only — they need no I/O, so a synchronous caller (the
 * `/mx/vende/promotor` glossary, the `about-content.ts` defaults) can fill them too. */
export function fixedPricingTokens(locale: PricingLocale): Record<string, string> {
  const perYear = locale === 'es' ? 'al año' : 'a year'
  return {
    subdomainPrice: yearlyLabel(SUBDOMAIN_PRICE_YEARLY_MXN, SUBDOMAIN_PRICE_MONTHLY_MXN)[locale],
    subdomainYearly: `${formatPesos(SUBDOMAIN_PRICE_YEARLY_MXN)} MXN ${perYear}`,
    customDomainPrice: yearlyLabel(CUSTOM_DOMAIN_PRICE_MXN, null)[locale],
    customDomainYearly: `${formatPesos(CUSTOM_DOMAIN_PRICE_MXN)} MXN ${perYear}`,
    mlSyncPrice: yearlyLabel(ML_SYNC_PRICE_YEARLY_MXN, ML_SYNC_PRICE_MONTHLY_MXN)[locale],
  }
}

export function pricingTokens(catalog: PricingCatalog, locale: PricingLocale): Record<string, string> {
  return {
    ...fixedPricingTokens(locale),
    printAdPrice: getExtra(catalog, 'print_ad').priceLabel[locale],
    migrationPrice: getExtra(catalog, 'migration').priceLabel[locale],
  }
}

function fillTokens(text: string, tokens: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (whole, key: string) => (key in tokens ? tokens[key] : whole))
}

/**
 * Replace every known `{token}` in `text`. An unknown `{word}` is left as written — a typo in
 * a token shows up visibly in review rather than silently becoming an empty string.
 */
export function fillPricingTokens(text: string, catalog: PricingCatalog, locale: PricingLocale): string {
  return fillTokens(text, pricingTokens(catalog, locale))
}

/** Fill only the fixed-price tokens; admin-price tokens stay as written (see `fixedPricingTokens`). */
export function fillFixedPricingTokens(text: string, locale: PricingLocale): string {
  return fillTokens(text, fixedPricingTokens(locale))
}
