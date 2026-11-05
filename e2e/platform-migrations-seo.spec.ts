import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { buildMigracionHubPageConfig } from '../app/(shell)/mx/vende/_components/page-config'

const BASE_URL = 'https://miyagisanchez.com'

type SellerPageMetadata = {
  title: string
  description: string
  ogAlt: string
}

const es = JSON.parse(readFileSync(new URL('../locales/es.json', import.meta.url), 'utf8')) as {
  sellerAcquisition: Record<string, { metadata: SellerPageMetadata }> & {
    shared: { migrationCallout: { title: string; body: string; ctaLabel: string } }
  }
}

const migrationPages = [
  { path: '/mx/vende/migracion', meta: es.sellerAcquisition.migracion.metadata },
  { path: '/mx/vende/migracion/shopify', meta: es.sellerAcquisition.migracionShopify.metadata },
  { path: '/mx/vende/migracion/tiendanube', meta: es.sellerAcquisition.migracionTiendanube.metadata },
  { path: '/mx/vende/migracion/woocommerce', meta: es.sellerAcquisition.migracionWoocommerce.metadata },
  { path: '/mx/vende/migracion/bigcartel', meta: es.sellerAcquisition.migracionBigcartel.metadata },
]

// Mirrors e2e/seller-acquisition-seo.spec.ts exactly — same shell, same assertions
// (platform-migrations epic 03 · Sprint 3 · US-3.1).
test.describe('platform migrations · SEO and OpenGraph', () => {
  for (const page of migrationPages) {
    test(`${page.path} exposes migration-page metadata`, async ({ request }) => {
      const res = await request.get(page.path)
      expect(res.ok()).toBeTruthy()

      const html = await res.text()
      expect(html).toContain(page.meta.title)
      expect(getMetaContents(html, 'name', 'description')).toContain(page.meta.description)
      expect(getMetaContents(html, 'property', 'og:title')).toContain(page.meta.title)
      expect(getMetaContents(html, 'property', 'og:description')).toContain(page.meta.description)
      expect(getMetaContents(html, 'property', 'og:url')).toContain(`${BASE_URL}${page.path}`)
      expect(getMetaContents(html, 'property', 'og:image:alt')).toContain(page.meta.ogAlt)
      expect(getMetaContents(html, 'name', 'twitter:card')).toContain('summary_large_image')
      expect(getLinkHrefs(html, 'canonical')).toContain(`${BASE_URL}${page.path}`)
    })

    // Same regression guard as seller-acquisition-seo.spec.ts — a hand-built
    // `${path}/opengraph-image` URL text-matches but 404s; assert the tag's own URL
    // actually renders.
    test(`${page.path} og:image meta tag points at a route that actually renders`, async ({ request }) => {
      const res = await request.get(page.path)
      expect(res.ok()).toBeTruthy()
      const html = await res.text()

      const [ogImageUrl] = getMetaContents(html, 'property', 'og:image')
      expect(ogImageUrl, 'og:image meta tag must be present').toBeTruthy()
      expect(ogImageUrl).toContain(`${page.path}/opengraph-image`)

      const imgRes = await request.get(ogImageUrl)
      expect(imgRes.ok(), `og:image route ${ogImageUrl} must return 200, not the hardcoded (unhashed) path`).toBeTruthy()
      expect(imgRes.headers()['content-type']).toContain('image/')
    })
  }

  test('platform sitemap lists every migration page', async ({ request }) => {
    const res = await request.get('/sitemap.xml')
    expect(res.ok()).toBeTruthy()

    const xml = await res.text()
    for (const page of migrationPages) {
      expect(xml).toContain(`<loc>${BASE_URL}${page.path}</loc>`)
    }
  })

  test('the hub page links to all 4 platform pages', async ({ request }) => {
    const res = await request.get('/mx/vende/migracion')
    expect(res.ok()).toBeTruthy()
    const html = await res.text()
    for (const platform of ['shopify', 'tiendanube', 'woocommerce', 'bigcartel']) {
      expect(html).toContain(`/mx/vende/migracion/${platform}`)
    }
  })

  // Cross-agent review of this PR (Codex) flagged a real gap: routerCards' `slug` comes
  // from admin-editable copy overrides (getOverriddenDictionary), not just the static
  // JSON — an `as keyof typeof MIGRACION_PLATFORM_PATHS` cast on a bad/typo'd slug would
  // have silently produced `href={undefined}`. Assert it degrades to the hub link instead.
  test('a router card with an unrecognized slug degrades to the hub link, never href=undefined', () => {
    const copy = JSON.parse(readFileSync(new URL('../locales/es.json', import.meta.url), 'utf8')).sellerAcquisition
    copy.migracion.routerCards = [...copy.migracion.routerCards, { slug: 'tiendanube-typo', eyebrow: '', title: '', body: '', icon: '' }]
    const config = buildMigracionHubPageConfig(copy, {})
    const badCard = config.personaRouter!.cards.find((c) => c.testId === 'migracion-router-tiendanube-typo')
    expect(badCard).toBeTruthy()
    expect(badCard!.href).toBe('/mx/vende/migracion')
  })

  test('the Shopify page links into the real, already-shipped connector flow', async ({ request }) => {
    const res = await request.get('/mx/vende/migracion/shopify')
    expect(res.ok()).toBeTruthy()
    const html = await res.text()
    expect(html).toContain('/shop/manage/shopify/import')
  })

  for (const path of ['/mx/vende/migracion/tiendanube', '/mx/vende/migracion/woocommerce', '/mx/vende/migracion/bigcartel']) {
    test(`${path} links into the shipped importer, not a dead/new route`, async ({ request }) => {
      const res = await request.get(path)
      expect(res.ok()).toBeTruthy()
      const html = await res.text()
      expect(html).toContain('/shop/manage/import')
    })
  }
})

test.describe('platform migrations · negocios/servicios migration callout (US-3.2)', () => {
  for (const path of ['/mx/vende/negocios', '/mx/vende/servicios']) {
    test(`${path} nudges a merchant coming from another platform toward /mx/vende/migracion`, async ({ request }) => {
      const res = await request.get(path)
      expect(res.ok()).toBeTruthy()
      const html = await res.text()
      expect(html).toContain('/mx/vende/migracion')
      expect(html).toContain(es.sellerAcquisition.shared.migrationCallout.title)
    })
  }
})

test.describe('platform migrations · consultant runbook (US-3.2)', () => {
  test('GET /mx/vende/promotor/migracion → 200 printable, noindex runbook', async ({ request }) => {
    const res = await request.get('/mx/vende/promotor/migracion', { headers: { Accept: 'text/html' } })
    expect(res.status()).toBe(200)
    const html = await res.text()
    expect(html).toContain('Guardar como PDF') // the .no-print toolbar hint, same as sell-sheet
    expect(getMetaContents(html, 'name', 'robots')).toContain('noindex')
  })

  test('the runbook links back to the promoter sell-sheet, and vice versa', async ({ request }) => {
    const runbook = await (await request.get('/mx/vende/promotor/migracion')).text()
    expect(runbook).toContain('/mx/vende/promotor/sell-sheet')

    const sellSheet = await (await request.get('/mx/vende/promotor/sell-sheet')).text()
    expect(sellSheet).toContain('/mx/vende/promotor/migracion')
  })

  // platform-migrations S2's own review found a hardcoded-price bug (the estimator's
  // base price duplicated instead of reading the same admin config the flat path
  // uses). Nothing in this repo lints for a hardcoded price in JSX automatically —
  // guard it at the source level: both pages must call the live reader, and must not
  // hardcode the epic-doc's $999 reference price as a bare literal.
  // The quick guide (sell-sheet) no longer prints a migration price: it links the migration guide, which does.
  test('the promoter quick guide types no migration price and links the migration guide', () => {
    const source = readFileSync(new URL('../app/(shell)/mx/vende/promotor/sell-sheet/page.tsx', import.meta.url), 'utf8')
    expect(source).not.toContain('$999')
    expect(source).toContain('/mx/vende/promotor/migracion')
  })
  for (const relPath of ['app/(shell)/mx/vende/promotor/migracion/page.tsx']) {
    test(`${relPath} sources the migration price from getPromoterSkuPrices(), not a literal`, () => {
      const source = readFileSync(new URL(`../${relPath}`, import.meta.url), 'utf8')
      expect(source).toContain('getPromoterSkuPrices')
      // The epic doc's reference price ($999 MXN) must never appear as a bare literal —
      // the only $-amount for `migration` in these files comes from the interpolated
      // `migrationPriceMxn` variable.
      expect(source).not.toContain('$999')
      expect(source).not.toContain('999_00')
    })
  }
})

test.describe('platform migrations · admin price-input fix (US-3.2)', () => {
  // Before this sprint, PromoterAdminClient.tsx hard-disabled the "Precio por SKU"
  // input for any SKU with no PROMOTER_SKU_BASE_PRICE_MXN entry — which included
  // `migration` (the SKU S2 shipped a whole money path around), making its $999
  // price literally impossible to set through the admin screen. Guard the fix at
  // the source level, since this repo has no browser test driving the admin UI.
  test('the admin price input is no longer unconditionally disabled for migration', () => {
    const source = readFileSync(
      new URL('../app/(shell)/admin/promoter/PromoterAdminClient.tsx', import.meta.url),
      'utf8',
    )
    expect(source).toContain('DIRECT_PRICE_SKUS')
    expect(source).toMatch(/DIRECT_PRICE_SKUS[^\n]*=[^\n]*\[[^\]]*'migration'[^\]]*\]/)
    // The OLD unconditional gate — every `disabled={...base == null}` in the file
    // (the price input AND its save button) must now also check `directPriced`.
    expect(source).not.toMatch(/disabled=\{(?:savingPrice === sku \|\| )?base == null\}/)
  })
})

function getMetaContents(html: string, attrName: 'name' | 'property', attrValue: string): string[] {
  return getTags(html, 'meta')
    .filter((tag) => getAttribute(tag, attrName) === attrValue)
    .map((tag) => getAttribute(tag, 'content'))
    .filter((value): value is string => Boolean(value))
}

function getLinkHrefs(html: string, rel: string): string[] {
  return getTags(html, 'link')
    .filter((tag) => getAttribute(tag, 'rel') === rel)
    .map((tag) => getAttribute(tag, 'href'))
    .filter((value): value is string => Boolean(value))
}

function getTags(html: string, tagName: 'link' | 'meta'): string[] {
  return html.match(new RegExp(`<${tagName}\\b[^>]*>`, 'g')) ?? []
}

function getAttribute(tag: string, attrName: string): string | undefined {
  const match = tag.match(new RegExp(`${attrName}=["']([^"']+)["']`, 'i'))
  return match?.[1]
}
