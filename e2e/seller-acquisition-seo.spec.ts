import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'

const BASE_URL = 'https://miyagisanchez.com'

type SellerPageMetadata = {
  title: string
  description: string
  ogAlt: string
}

const es = JSON.parse(readFileSync(new URL('../locales/es.json', import.meta.url), 'utf8')) as {
  sellerAcquisition: Record<string, { metadata: SellerPageMetadata }>
}

const sellerPages = [
  // The anchor landing is the root since root-shop-builder-home.
  { path: '/', meta: es.sellerAcquisition.anchor.metadata },
  { path: '/mx/vende/mundial', meta: es.sellerAcquisition.mundial.metadata },
  { path: '/mx/vende/creadores', meta: es.sellerAcquisition.creadores.metadata },
  { path: '/mx/vende/negocios', meta: es.sellerAcquisition.negocios.metadata },
  { path: '/mx/vende/servicios', meta: es.sellerAcquisition.servicios.metadata },
  { path: '/mx/vende/autos', meta: es.sellerAcquisition.autos.metadata },
]

test.describe('seller acquisition · SEO and OpenGraph', () => {
  for (const page of sellerPages) {
    test(`${page.path} exposes persona metadata`, async ({ request }) => {
      const res = await request.get(page.path)
      expect(res.ok()).toBeTruthy()

      const html = await res.text()
      expect(html).toContain(page.meta.title)
      expect(getMetaContents(html, 'name', 'description')).toContain(page.meta.description)
      expect(getMetaContents(html, 'property', 'og:title')).toContain(page.meta.title)
      expect(getMetaContents(html, 'property', 'og:description')).toContain(page.meta.description)
      // Next writes the root's absolute URL without its trailing slash (`https://miyagisanchez.com`).
      const absolute = page.path === '/' ? BASE_URL : `${BASE_URL}${page.path}`
      expect(getMetaContents(html, 'property', 'og:url')).toContain(absolute)
      expect(getMetaContents(html, 'property', 'og:image:alt')).toContain(page.meta.ogAlt)
      expect(getMetaContents(html, 'name', 'twitter:card')).toContain('summary_large_image')
      expect(getLinkHrefs(html, 'canonical')).toContain(absolute)
    })

    // agent-discovery-and-indexing S1.3 — regression guard. The og:image URL used to be
    // hand-built as `${path}/opengraph-image`, which 404s: Next serves file-convention OG
    // images at a content-hashed path (e.g. `/mx/vende/opengraph-image-<hash>`), so a substring
    // check on the meta tag's URL text passed even while the route itself was dead. Assert
    // the meta tag's own URL is actually LIVE, not just shaped like the page's path.
    test(`${page.path} og:image meta tag points at a route that actually renders`, async ({ request }) => {
      const res = await request.get(page.path)
      expect(res.ok()).toBeTruthy()
      const html = await res.text()

      const [ogImageUrl] = getMetaContents(html, 'property', 'og:image')
      expect(ogImageUrl, 'og:image meta tag must be present').toBeTruthy()
      expect(ogImageUrl).toContain(`${page.path === '/' ? '' : page.path}/opengraph-image`)

      // Next resolves the auto-detected image route to the CURRENT request origin (not the
      // static metadataBase), so the tag is already a full, directly-fetchable URL here.
      const imgRes = await request.get(ogImageUrl)
      expect(imgRes.ok(), `og:image route ${ogImageUrl} must return 200, not the hardcoded (unhashed) path`).toBeTruthy()
      expect(imgRes.headers()['content-type']).toContain('image/')
    })
  }

  test('platform sitemap lists every seller acquisition page', async ({ request }) => {
    const res = await request.get('/sitemap.xml')
    expect(res.ok()).toBeTruthy()

    const xml = await res.text()
    for (const page of sellerPages) {
      // The sitemap may write the root either way; both are the same URL.
      const loc = page.path === '/' ? new RegExp(`<loc>${BASE_URL}/?</loc>`) : `<loc>${BASE_URL}${page.path}</loc>`
      if (typeof loc === 'string') expect(xml).toContain(loc)
      else expect(xml).toMatch(loc)
    }
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
