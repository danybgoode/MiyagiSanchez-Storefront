import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MARKETPLACE_SHOP_TAILS } from '../lib/public-read-routing'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative: string) => fs.readFileSync(path.join(ROOT, relative), 'utf8')

test.describe('public renderer parity · D7/D8/D19', () => {
  test('public shop dispatches into every shipped rich surface, including embed', () => {
    const route = read('app/(public-read)/internal-public-read/[channel]/[identity]/[slug]/shop/[[...rest]]/page.tsx')
    expect(route).toContain("from '@/app/(shell)/s/[slug]/ShopRenderer'")
    expect(route).toContain("from '@/app/(shell)/embed/s/[slug]/page'")
    // The population is the set middleware rewrites into this route, not a hand-kept list: the catalog (share-kit
    // D8) joined the set, and a tail with no case here renders a 404 from the edge cache.
    expect(MARKETPLACE_SHOP_TAILS.size).toBeGreaterThanOrEqual(7)
    for (const surface of MARKETPLACE_SHOP_TAILS) {
      expect(route).toContain(`case '${surface}'`)
    }
    expect(route).not.toContain('getMarketplaceShopListings')
    expect(route).not.toContain('formatPrice')
  })

  test('public PDP is the shipped renderer with one island and all specialized actions', () => {
    const route = read('app/(public-read)/internal-public-read/[channel]/[identity]/[slug]/listing/[id]/page.tsx')
    const renderer = read('app/(shell)/l/[id]/ListingRenderer.tsx')
    const island = read('app/components/PublicPdpViewerIsland.tsx')
    expect(route).toContain("from '@/app/(shell)/l/[id]/ListingRenderer'")
    expect(route).not.toContain("from '@/lib/listings'")
    expect(renderer.match(/<PublicPdpViewerIsland\b/g)).toHaveLength(1)
    for (const kind of ['print', 'schedule', 'configurator', 'personalization', 'event', 'rental', 'subscription', 'digital']) {
      expect(island).toContain(`action.kind === '${kind}'`)
    }
    expect(renderer).toContain("kind: 'print'")
    expect(renderer).toContain("kind: 'schedule'")
    expect(renderer).toContain('schedule: autoLed')
    for (const hero of ['ServiceHero', 'AutoHero', 'InmuebleHero']) {
      expect(renderer).toMatch(new RegExp(`<${hero}\\b[\\s\\S]*?showActions=\\{!isPublicViewer\\}`))
    }
  })

  test('only dynamic adapters own request state and preview overlay imports', () => {
    const shopAdapter = read('app/(shell)/s/[slug]/page.tsx')
    const shopRenderer = read('app/(shell)/s/[slug]/ShopRenderer.tsx')
    const listingAdapter = read('app/(shell)/l/[id]/page.tsx')
    const listingRenderer = read('app/(shell)/l/[id]/ListingRenderer.tsx')
    const context = read('lib/shop-presentation/context.ts')
    const requestContext = read('lib/shop-presentation/request-context.ts')

    expect(shopAdapter).toContain("from 'next/headers'")
    expect(shopAdapter).toContain('shop-presentation/preview')
    expect(shopRenderer).not.toContain("from 'next/headers'")
    expect(shopRenderer).not.toContain('shop-presentation/preview')
    expect(listingAdapter).toContain("from '@clerk/nextjs/server'")
    expect(listingRenderer).not.toContain("from '@clerk/nextjs/server'")
    expect(context).not.toContain("from 'next/headers'")
    expect(requestContext).toContain("from 'next/headers'")
  })

  test('the single viewer read is listing-keyed, fail-closed, and does not render numeric zero', () => {
    const island = read('app/components/PublicPdpViewerIsland.tsx')
    expect(island).toContain('started.current === requestKey')
    expect(island).toContain('result?.key === requestKey')
    expect(island).toContain('controller.abort()')
    expect(island).toContain('listing.priceCents > 0')
    expect(island).toContain('skipActiveOfferRead')
    expect(island.indexOf("deal?.status === 'accepted_unpaid'")).toBeLessThan(island.indexOf('{actionContent}'))
  })
})
