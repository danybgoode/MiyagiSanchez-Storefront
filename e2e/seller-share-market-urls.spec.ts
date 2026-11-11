import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { marketplaceUrl, shopUrlFor } from '../lib/market-url'
import { isBoundaryDeniedPath } from '../lib/route-shape'

const ROOT = path.resolve(import.meta.dirname, '..')
const SELLER_SHARE_SURFACES = [
  'app/(shell)/sell/SellWizard.tsx',
  'app/(shell)/sell/setup/SetupClient.tsx',
  'app/(shell)/shop/manage/import/ImportClient.tsx',
  'app/(shell)/shop/manage/canal-propio/ShareToolsSection.tsx',
] as const

test.describe('seller public-shop share URLs', () => {
  test('the shared shop seam produces valid platform and tenant destinations', () => {
    const platformUrl = shopUrlFor('https://miyagisanchez.com', 'tienda-demo')
    const tenantUrl = shopUrlFor('https://tienda.example', 'tienda-demo')

    expect(platformUrl).toBe('https://miyagisanchez.com/mx/s/tienda-demo')
    expect(tenantUrl).toBe('https://tienda.example/')
    // `/mx/s/*` is valid on the platform precisely because it is a tenant-denied
    // shape. Seller tools must never combine this path with their ambient host.
    expect(isBoundaryDeniedPath(new URL(platformUrl).pathname)).toBe(true)
    expect(isBoundaryDeniedPath(new URL(tenantUrl).pathname)).toBe(false)
  })

  test('seller success and share surfaces deliberately target the platform marketplace', () => {
    for (const file of SELLER_SHARE_SURFACES) {
      const source = readFileSync(path.join(ROOT, file), 'utf8')

      expect(source, file).toContain("from '@/lib/market-url'")
      expect(source, file).toContain("from '@/lib/market-seo'")
      expect(source, file).toContain('shopUrlFor(SITE_ORIGIN,')
      expect(source, file).not.toContain('window.location.origin')
      expect(source, file).not.toMatch(/(?:liveUrl|shareUrl|href)=\{?['"`]\/mx\/s\//)
    }
  })

  test('the manuscript-call management link keeps its shop subpath on the platform origin', () => {
    expect(
      marketplaceUrl(
        'https://miyagisanchez.com',
        '/s/editorial-demo/convocatoria',
      ),
    ).toBe('https://miyagisanchez.com/mx/s/editorial-demo/convocatoria')

    const file = 'app/(shell)/shop/manage/convocatoria/page.tsx'
    const source = readFileSync(path.join(ROOT, file), 'utf8')
    expect(source).toContain("from '@/lib/market-url'")
    expect(source).toContain("from '@/lib/market-seo'")
    expect(source).toContain(
      "publicUrl={marketplaceUrl(SITE_ORIGIN, `/s/${shop.slug}/convocatoria`)}",
    )
    expect(source).not.toContain('publicUrl={`/mx/s/')
  })

  test('the launchpad shelf API returns an absolute platform collection URL', () => {
    expect(
      marketplaceUrl(
        'https://miyagisanchez.com',
        '/s/editorial-demo/c/convocatoria',
      ),
    ).toBe('https://miyagisanchez.com/mx/s/editorial-demo/c/convocatoria')

    const file = 'app/api/sell/launchpad/shelf/route.ts'
    const source = readFileSync(path.join(ROOT, file), 'utf8')
    expect(source).toContain("from '@/lib/market-url'")
    expect(source).toContain("from '@/lib/market-seo'")
    expect(source).toContain(
      'marketplaceUrl(SITE_ORIGIN, `/s/${sellerSlug}/c/${shortSlug}`)',
    )
    expect(source).not.toContain('`/mx/s/${state.sellerSlug}/c/${shortSlug}`')
  })
})
