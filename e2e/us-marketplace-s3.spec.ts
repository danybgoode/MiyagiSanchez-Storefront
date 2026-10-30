import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { resolveCommerceReadiness } from '../lib/commerce-readiness'

const ROOT = process.cwd()
const source = (relative: string) => readFileSync(path.join(ROOT, relative), 'utf8')

test.describe('US marketplace Sprint 3 contract', () => {
  test('the literal US landing is a thin adapter over the shared marketplace home', () => {
    const us = source('app/(us-site)/us/page.tsx')
    const shared = source('app/(mx-site)/mx/page.tsx')
    // `/en` is the one document that renders the selector since root-shop-builder-home.
    const selector = source('app/(en-site)/en/page.tsx')

    expect(us).toContain("import { MarketHomePage } from '@/app/(mx-site)/mx/page'")
    expect(us).toContain("MarketHomePage({ market: 'us' })")
    expect(us).not.toContain('OperatorApplication')
    expect(shared).toContain('export async function MarketHomePage')
    expect(shared).toContain('getRecentListings(RECIEN_LLEGADO_FETCH_LIMIT, market)')
    expect(shared).toContain('getFeaturedListing(now, market)')
    expect(shared).toContain('getCuratedListings(now, market)')
    // The selector's US card says the market is OPEN, and it no longer says it in a
    // source literal: the card copy moved into the dictionary when `/` gained an
    // English twin at `/en`, because a literal cannot be translated. Asserted against
    // the copy that actually renders, in BOTH languages — a claim that is only true in
    // Spanish is the failure this page's US card was built to avoid.
    const es = JSON.parse(source('locales/es.json'))
    const en = JSON.parse(source('locales/en.json'))
    expect(es.buyerCopy['page.marketCardUsLede'])
      .toContain('Mercado abierto para explorar tiendas y productos en dólares')
    expect(en.buyerCopy['page.marketCardUsLede'])
      .toContain('An open market for exploring shops and products in dollars')
    for (const dictionary of [es, en]) {
      for (const value of Object.values(dictionary.buyerCopy) as string[]) {
        expect(value).not.toMatch(/Piloto privado|Conocer el piloto|Private pilot/)
      }
    }
    // And the selector still renders that copy rather than having quietly kept a literal.
    expect(source('app/(site)/MarketSelector.tsx')).toContain('page.marketCardUsLede')
    expect(selector).toContain('<MarketSelector language="en" />')
  })

  test('US has its own en-US shell and browse adapter while partner recruiting remains intact', () => {
    const layout = source('app/(us-shell)/layout.tsx')
    const browse = source('app/(us-shell)/us/l/page.tsx')

    expect(layout).toContain('<MarketDocument market="us">')
    expect(layout).toContain('<PlatformShell market="us"')
    expect(browse).toContain("market: 'us'")
    // Recruiting kept its own reachable ROUTE, not merely a surviving component file:
    // opening `/us` as the marketplace displaced the flag gate that used to live there,
    // and a spec that only asserts the form file exists cannot see that happen.
    expect(source('app/(us-site)/us/operators/OperatorApplication.tsx')).toContain('export function OperatorApplication')
    expect(source('app/(us-site)/us/operators/page.tsx')).toContain('SellerAcquisitionPage')
    expect(source('app/(us-site)/us/page.tsx')).not.toContain('recruitingV3Enabled')
    expect(source('app/(shell)/partner/page.tsx')).toContain('export default async function PartnerDashboardPage')
    expect(source('app/(shell)/partner/page.tsx')).toContain('partnerWorkspaceAdmitted')
  })

  test('missing market-owned catalog credentials produce a named unavailable surface', () => {
    const resolver = source('lib/market-medusa.ts')
    const listings = source('lib/listings.ts')
    const browse = source('app/(shell)/l/page.tsx')

    expect(resolver).toContain("us: Object.freeze(['MEDUSA_US_PUBLISHABLE_KEY'])")
    expect(listings).toContain('async (slug: string, market?: MarketCode)')
    expect(listings).toContain('async (sellerSlug: string, market?: MarketCode)')
    expect(listings).toContain('marketCredentialUnavailable(decision.market)')
    expect(listings).toContain("reason: 'market_filter_unavailable'")
    expect(browse).toContain('data-testid="market-catalog-unavailable"')
    expect(browse).toContain('market.catalogUnavailableHeading')
  })

  test('commerce readiness admits US now that its direct-charge rail exists (S4)', () => {
    // S3 pinned the opposite: `checkout_not_available`, permanently, because there was
    // no US payment rail. S4.1 built it (Stripe Connect direct charges, proven in test
    // mode) and S4.2 gave it a delivery method, so the honest answer changed. D13's
    // rule was never "US is unbuyable" — it was "be honest about whether it is", and
    // leaving this red would now be the dishonest state.
    expect(resolveCommerceReadiness({ market: 'mx', priceCents: 10_000, currency: 'MXN', sellerPaymentAvailable: true }))
      .toEqual({ ready: true, market_code: 'mx', reason: 'ready' })
    expect(resolveCommerceReadiness({ market: 'us', priceCents: 10_000, currency: 'USD', sellerPaymentAvailable: true }))
      .toEqual({ ready: true, market_code: 'us', reason: 'ready' })
    // The rail existing does NOT weaken the other gates — a US shop with no connected
    // Stripe account is still refused, by the same named result.
    expect(resolveCommerceReadiness({ market: 'us', priceCents: 10_000, currency: 'USD', sellerPaymentAvailable: false }))
      .toEqual({ ready: false, market_code: 'us', reason: 'seller_payment_unavailable' })
    expect(resolveCommerceReadiness({ market: 'us', priceCents: 10_000, currency: 'MXN', sellerPaymentAvailable: true }))
      .toEqual({ ready: false, market_code: 'us', reason: 'currency_mismatch' })
    expect(resolveCommerceReadiness({ market: 'us', priceCents: 0, currency: 'USD', sellerPaymentAvailable: true }))
      .toEqual({ ready: false, market_code: 'us', reason: 'missing_positive_price' })
    expect(resolveCommerceReadiness({ market: 'mx', priceCents: 10_000, currency: 'USD', sellerPaymentAvailable: true }))
      .toEqual({ ready: false, market_code: 'mx', reason: 'currency_mismatch' })
    expect(resolveCommerceReadiness({ market: 'mx', priceCents: 10_000, currency: 'MXN', sellerPaymentAvailable: false }))
      .toEqual({ ready: false, market_code: 'mx', reason: 'seller_payment_unavailable' })
  })

  test('agent discovery names both active market vocabularies and commerce readiness', () => {
    const manifest = source('app/api/ucp/manifest/route.ts')
    const mcp = source('app/api/ucp/mcp/route.ts')
    const schema = source('lib/ucp/schema.ts')

    expect(manifest).toContain('active Mexico and United States country marketplaces')
    expect(manifest).toContain("market:        'mx | us (legacy default: mx)'")
    expect(mcp).toContain('active Mexico (`mx`) and United States (`us`) country marketplaces')
    expect(mcp).not.toMatch(/us is an invitation|invitation markets return/i)
    expect(schema).toContain('commerce_readiness: CommerceReadiness')
    expect(schema).toContain('const buyNow = commerceReadiness.ready')
    expect(schema).toContain('buy_now: buyNow')
  })

  test('US browse is an indexable sitemap destination', () => {
    expect(source('lib/market-sitemap.ts')).toContain("{ path: '/us/l', changeFrequency: 'daily', priority: 0.9 }")
    expect(source('app/(us-shell)/us/l/page.tsx')).toContain("market: 'us'")
  })
})
