import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  browseUrlFor,
  listingUrlFor,
  marketplaceUrl,
  shopUrlFor,
} from '../lib/market-url'

const ROOT = path.resolve(import.meta.dirname, '..')

const PROGRAM_SURFACES = {
  'app/(shell)/admin/supply/SupplyClient.tsx': [
    'browseUrlFor(SITE_ORIGIN)',
    'listingUrlFor(SITE_ORIGIN, item.imported_listing_id)',
  ],
  'app/(shell)/vecindario/page.tsx': [
    'listingUrlFor(SITE_ORIGIN, listing.id)',
    'shopUrlFor(SITE_ORIGIN, shop.slug)',
  ],
  'app/(shell)/g/[slug]/page.tsx': [
    'shopUrlFor(SITE_ORIGIN, shop.slug)',
  ],
  'app/(shell)/v/[slug]/page.tsx': [
    'listingUrlFor(SITE_ORIGIN, w.product_id)',
    'shopUrlFor(SITE_ORIGIN, shop.slug)',
  ],
  'app/(shell)/embed/s/[slug]/page.tsx': [
    'listingUrlFor(SITE_ORIGIN, id)',
  ],
  'app/(shell)/partner/page.tsx': [
    'shopUrlFor(SITE_ORIGIN, g.shop.slug)',
  ],
  'app/(shell)/promotor/cerrar/ListingStep.tsx': [
    'shopUrlFor(SITE_ORIGIN, shop.slug)',
  ],
  'app/(shell)/promotor/cerrar/PreviewStep.tsx': [
    'shopUrlFor(SITE_ORIGIN, shop.slug)',
  ],
  'app/(shell)/promotor/cerrar/PromoterCloseClient.tsx': [
    'shopUrlFor(SITE_ORIGIN, shop.slug)',
  ],
} as const

test.describe('platform program public catalog URLs', () => {
  test('the shared seams produce canonical absolute platform destinations', () => {
    expect(browseUrlFor('https://miyagisanchez.com')).toBe(
      'https://miyagisanchez.com/mx/l',
    )
    expect(listingUrlFor('https://miyagisanchez.com', 'prod_123')).toBe(
      'https://miyagisanchez.com/mx/l/prod_123',
    )
    expect(shopUrlFor('https://miyagisanchez.com', 'tienda-demo')).toBe(
      'https://miyagisanchez.com/mx/s/tienda-demo',
    )
    expect(
      marketplaceUrl(
        'https://miyagisanchez.com',
        '/s/tienda-demo/coleccion/novedades',
      ),
    ).toBe(
      'https://miyagisanchez.com/mx/s/tienda-demo/coleccion/novedades',
    )
  })

  test('program surfaces deliberately leave tenant hosts for the platform catalog', () => {
    for (const [file, expectedCalls] of Object.entries(PROGRAM_SURFACES)) {
      const source = readFileSync(path.join(ROOT, file), 'utf8')

      expect(source, file).toContain("from '@/lib/market-url'")
      expect(source, file).toContain("from '@/lib/market-seo'")
      for (const call of expectedCalls) expect(source, file).toContain(call)

      expect(source, file).not.toContain('window.location.origin')
      expect(source, file).not.toMatch(/['"`]\/mx\/(?:l|s)(?:\/|['"`])/)
    }
  })

  test('the embed handoff preserves attribution on the canonical platform PDP', () => {
    const file = 'app/(shell)/embed/s/[slug]/page.tsx'
    const source = readFileSync(path.join(ROOT, file), 'utf8')

    expect(source).toContain(
      "`${listingUrlFor(SITE_ORIGIN, id)}?channel=embed${key ? `&ref_key=${encodeURIComponent(key)}` : ''}`",
    )
  })
})
