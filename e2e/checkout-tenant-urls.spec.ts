import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { browseUrlFor, listingUrlFor } from '../lib/market-url'

const ROOT = path.resolve(import.meta.dirname, '..')
const CHECKOUT_PAGE = readFileSync(
  path.join(ROOT, 'app/(shell)/checkout/page.tsx'),
  'utf8',
)

test.describe('checkout tenant-aware fallback URLs', () => {
  test('shared URL seams keep platform paths prefixed and tenant paths native', () => {
    expect(new URL(browseUrlFor('https://miyagisanchez.com')).pathname).toBe('/mx/l')
    expect(new URL(listingUrlFor('https://miyagisanchez.com', 'prod_123')).pathname).toBe(
      '/mx/l/prod_123',
    )

    expect(new URL(browseUrlFor('https://seller.example')).pathname).toBe('/')
    expect(new URL(listingUrlFor('https://seller.example', 'prod_123')).pathname).toBe(
      '/l/prod_123',
    )
  })

  test('checkout derives its catalog paths from trusted channel headers', () => {
    expect(CHECKOUT_PAGE).toContain("import { headers } from 'next/headers'")
    expect(CHECKOUT_PAGE).toContain("import { browseUrlFor, listingUrlFor } from '@/lib/market-url'")
    expect(CHECKOUT_PAGE).toContain("channel === 'custom' || channel === 'subdomain'")
    expect(CHECKOUT_PAGE).toContain("requestHeaders.get('x-miyagi-domain')")
    expect(CHECKOUT_PAGE).toContain(
      'const browsePath = new URL(browseUrlFor(marketOrigin)).pathname',
    )
    // A marketplace product's back link is channel-aware as before. A «Solo mi
    // tienda» product has no `/mx/l` page, so on the PLATFORM it goes back to the
    // shop-scoped PDP; on a tenant host it keeps the native `/l/<id>`.
    expect(CHECKOUT_PAGE).toContain(
      ': new URL(listingUrlFor(marketOrigin, listing.id)).pathname',
    )
    expect(CHECKOUT_PAGE).toMatch(
      /const listingPath = ownedShopSlug && !onTenantChannel\s*\?\s*shopScopedListingPath\(ownedShopSlug, listing\.id\)/,
    )

    // The query-string `origin` is a checkout return hint, not a trusted source
    // for deciding which catalog boundary a fallback link belongs to.
    expect(CHECKOUT_PAGE).not.toMatch(/marketOrigin\s*=.*params\.origin/)
  })

  test('every browse, PDP fallback, and back link uses the channel-aware paths', () => {
    expect(CHECKOUT_PAGE.match(/redirect\(browsePath\)/g)).toHaveLength(1)
    expect(CHECKOUT_PAGE.match(/redirect\(listingPath\)/g)).toHaveLength(2)
    expect(
      CHECKOUT_PAGE.match(/redirect\(`\$\{listingPath\}\?offer=unavailable`\)/g),
    ).toHaveLength(1)
    expect(
      CHECKOUT_PAGE.match(/redirect\(`\$\{listingPath\}\?checkout=unavailable`\)/g),
    ).toHaveLength(4)
    expect(CHECKOUT_PAGE.match(/<Link href=\{listingPath\}/g)).toHaveLength(1)

    expect(CHECKOUT_PAGE).not.toContain("redirect('/mx/l')")
    expect(CHECKOUT_PAGE).not.toMatch(/redirect\(`\/mx\/l/)
    expect(CHECKOUT_PAGE).not.toMatch(/href=\{`\/mx\/l/)
  })
})
