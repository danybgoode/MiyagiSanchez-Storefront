import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { aboutLlmsTxt, aboutManifestBlock, aboutMcpResource } from '../lib/about-agent'
import { ABOUT_PAGE, ABOUT_SECTIONS, ABOUT_CTA_HREF } from '../lib/about-content'
import {
  BUSINESS_PROOF,
  BUSINESS_TYPE_PAGES,
  BUSINESS_TYPE_SLUGS,
  DEMO_SHOPS,
  NEW_BUSINESS_TYPE_SLUGS,
  businessProofFor,
  businessTypePath,
} from '../lib/business-types'
import { SHOP_FEATURES, SHOP_FEATURE_IDS } from '../lib/shop-features'
import { BusinessProofSlot } from '../app/(shell)/mx/vende/_components/BusinessProofSlot'

/**
 * own-shop-positioning — the three stories, as one deterministic gate.
 *
 *   S1.1 the definition: «tu propia tienda, armada contigo, sin comisión por venta» everywhere, «Abrir mi tienda»
 *        everywhere a merchant is asked to start, the marketplace out of the header, the support promise (no number).
 *   S2.1 the six stories, each linking to a real feature, on `/`, in `about_miyagi` and as a list on `/mx/precios`.
 *   S3.1 ten business-type pages: no-JS, OG + canonical, a demo shop labelled «ejemplo», an empty proof slot that
 *        renders nothing.
 *
 * The pure half (copy modules, the proof slot) needs no server; the HTTP half reads `baseURL` like every api spec.
 */

const ROOT = new URL('..', import.meta.url).pathname
const es = JSON.parse(readFileSync(`${ROOT}locales/es.json`, 'utf8'))
const en = JSON.parse(readFileSync(`${ROOT}locales/en.json`, 'utf8'))

const DEFINITION_ES = 'Miyagi Sánchez es tu propia tienda en línea, armada contigo, sin comisión por venta.'
const DEFINITION_EN = 'Miyagi Sánchez is your own online shop, built with you, with no commission on sales.'
const RETIRED_IDENTITY = /\bP2P\b|marketplace nativo|agent-native marketplace|peer-to-peer/i
const AGENT_LINE = 'Tu agente de IA'
const PROMOTER_LEAD = 'Tu promotor te arma la tienda y te atiende por su WhatsApp; entre visitas, tu agente de IA responde.'

// Drops <script> and <style> blocks by index scan, not by regex (CodeQL flags regex HTML filtering). This only
// reads OUR rendered page in a test; it is not a sanitizer.
function dropBlocks(html: string, tag: string): string {
  const lower = html.toLowerCase()
  let out = ''
  let i = 0
  for (;;) {
    const start = lower.indexOf(`<${tag}`, i)
    if (start === -1) return out + html.slice(i)
    const close = lower.indexOf(`</${tag}`, start)
    const end = close === -1 ? -1 : lower.indexOf('>', close)
    out += html.slice(i, start) + ' '
    if (end === -1) return out
    i = end + 1
  }
}

function stripTags(html: string): string {
  return dropBlocks(dropBlocks(html, 'script'), 'style').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
}

function block(html: string, testId: string): string {
  const start = html.indexOf(`data-testid="${testId}"`)
  if (start < 0) return ''
  const open = html.lastIndexOf('<section', start)
  return html.slice(open, html.indexOf('</section>', start) + '</section>'.length)
}

// ── S1.1 · the definition (pure) ───────────────────────────────────────────────

test.describe('S1.1 · one definition, one source', () => {
  test('the about content leads with the own-shop sentence in es and en, and the CTA opens the shop builder', () => {
    const whatIs = ABOUT_SECTIONS.find((s) => s.id === 'what_is')!
    expect(whatIs.es.body[0]).toBe(DEFINITION_ES)
    expect(whatIs.en.body[0]).toBe(DEFINITION_EN)
    expect(ABOUT_PAGE.es.primaryCtaLabel).toBe('Abrir mi tienda')
    expect(ABOUT_CTA_HREF).toBe('/')
    // The Vecindario appears as a benefit, once, in the same section.
    expect(whatIs.es.body.join(' ')).toContain('Tus productos también aparecen en el Vecindario de Miyagi Sánchez')
  })

  test('every projection of the about content (llms.txt, manifest, about_miyagi) repeats it and retires P2P', () => {
    const base = 'https://example.test'
    const llms = aboutLlmsTxt(base)
    const manifest = JSON.stringify(aboutManifestBlock(base))
    const mcp = aboutMcpResource(base).text
    for (const [name, text] of [['llms.txt', llms], ['manifest', manifest], ['about_miyagi', mcp]] as const) {
      expect(text, name).toContain('your own online shop')
      expect(text, name).not.toMatch(RETIRED_IDENTITY)
    }
    expect(llms).toContain(DEFINITION_ES)
  })

  test('both locales carry the definition and none of the retired identity wording in acerca.*', () => {
    expect(es.acerca.sections.what_is.body[0]).toBe(DEFINITION_ES)
    expect(en.acerca.sections.what_is.body[0]).toBe(DEFINITION_EN)
    expect(JSON.stringify(es.acerca)).not.toMatch(RETIRED_IDENTITY)
    expect(JSON.stringify(en.acerca)).not.toMatch(RETIRED_IDENTITY)
  })

  test('the CTAs read «Abrir mi tienda» in es; the US chrome and US landing keep English', () => {
    expect(es.buyerShell.publishFree).toBe('Abrir mi tienda')
    expect(es.buyerShell.footer.sellFree).toBe('Abrir mi tienda')
    expect(es.sellerAcquisition.anchor.primaryCta).toBe('Abrir mi tienda')
    expect(es.sellerAcquisition.us.primaryCta).toBe('Abrir mi tienda')
    expect(es.acerca.page.primaryCtaLabel).toBe('Abrir mi tienda')
    expect(en.sellerAcquisition.us.primaryCta).toBe('Start free')
    expect(en.buyerShell.publishFree).toBe('Post for free')
  })

  test('the support promise names the promoter and the agent — never a platform number or hours', () => {
    const support = es.sellerAcquisition.shared.support
    expect(support.promoterLead).toBe(PROMOTER_LEAD)
    const text = JSON.stringify(support)
    expect(text).not.toMatch(/\d{2}[\s-]?\d{4}|tel:|\+52|lunes|horario|24\/7|de \d+ a \d+/i)
    expect(text).toContain('por su WhatsApp')
  })
})

// ── S1.1 · the header, the footer, `/` (http) ──────────────────────────────────

test.describe('S1.1 · chrome and landing (http, no JS)', () => {
  test('the header CTA and the footer link read «Abrir mi tienda» and go to the shop builder', async ({ request }) => {
    const html = await (await request.get('/mx', { headers: { Accept: 'text/html' } })).text()
    expect(html).toMatch(/<a[^>]*href="\/"[^>]*>\s*Abrir mi tienda/)
    expect(html).not.toMatch(/Publicar gratis|Vende gratis/)
  })

  test('the Vecindario left the header and stays in the footer', async ({ request }) => {
    const html = await (await request.get('/mx', { headers: { Accept: 'text/html' } })).text()
    const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'))
    expect(header.length).toBeGreaterThan(200)
    expect(header).not.toContain('href="/vecindario"')
    const footer = html.slice(html.indexOf('data-testid="site-footer"'))
    expect(footer).toContain('href="/vecindario"')
  })

  test('/ has one Vecindario-benefit line, no buyer line, and the agent-only support block', async ({ request }) => {
    const html = await (await request.get('/', { headers: { Accept: 'text/html' } })).text()
    const text = stripTags(html)
    expect(text).toContain('Tus productos también aparecen en el Vecindario de Miyagi Sánchez.')
    expect(text).not.toMatch(/¿Vienes a comprar\?|Explora el marketplace/)
    const support = stripTags(block(html, 'seller-support'))
    expect(support).toContain(AGENT_LINE)
    // A self-serve page reads the agent line only (D4).
    expect(support).not.toContain('Tu promotor')
    expect(html).toMatch(/data-testid="[a-z-]*primary-cta"[^>]*>\s*Abrir mi tienda|Abrir mi tienda\s*<i/)
  })
})

// ── S2.1 · six stories ──────────────────────────────────────────────────────────

test.describe('S2.1 · what the shop already does', () => {
  test('six stories, each with at least one link to a real feature page', () => {
    expect(SHOP_FEATURE_IDS).toEqual(['omnichannel', 'finanzas', 'ofertas', 'ia', 'sorteos', 'en-linea'])
    const known = ['/shop/manage/canal-propio', '/shop/manage/plan', '/shop/manage/analytics', '/shop/manage/offers', '/shop/manage/import', '/shop/manage/settings', '/shop/manage/sweepstakes', '/']
    for (const f of SHOP_FEATURES) {
      expect(f.links.length, f.id).toBeGreaterThan(0)
      for (const l of f.links) expect(known, `${f.id} -> ${l.href}`).toContain(l.href)
    }
    expect(SHOP_FEATURES[0].es.title).toBe('Un inventario para cada mostrador')
    expect(SHOP_FEATURES[1].es.title).toBe('Cuánto ganas, no sólo cuánto vendes')
  })

  test('the AI story claims only what the merchant\'s agent can really do over MCP', () => {
    const ai = SHOP_FEATURES.find((f) => f.id === 'ia')!.es.body
    const mcp = readFileSync(`${ROOT}app/api/ucp/mcp/route.ts`, 'utf8')
    // Every verb the story promises maps to a tool the route actually registers.
    for (const tool of ['create_listing', 'update_listing', 'respond_to_offer', 'get_business_plan', 'compare_costs']) {
      expect(mcp, `${tool} must exist in the MCP route`).toContain(`name: '${tool}'`)
    }
    // The promise is the EXACT clause below, each verb paired with the tool that backs it. Asserting only that the
    // verbs are present would let an invented one ride along («haga tu contabilidad») — an overclaim is the failure.
    const promised = ai.match(/pídele que ([^.]+)\./)?.[1]
    expect(promised).toBe('publique un producto, cambie un precio, responda una oferta, te diga cómo va tu plan o cuánto pagarías en otra plataforma')
  })

  test('about_miyagi, llms.txt and the manifest carry the six stories with their feature paths', () => {
    const base = 'https://example.test'
    const resource = aboutMcpResource(base)
    const section = resource.structured.sections.find((s) => s.id === 'features')!
    expect(section.es.points).toHaveLength(6)
    expect(section.en.points).toHaveLength(6)
    expect(section.es.points!.map((p) => p.title)).toContain('Un inventario para cada mostrador')
    expect(resource.text).toContain('miyagisanchez.com/shop/manage/offers')
    expect(aboutLlmsTxt(base)).toContain('What your shop already does')
    expect(aboutManifestBlock(base).features).toHaveLength(6)
  })

  test('the live locale mirror of the features section has not drifted from the one source', () => {
    const section = ABOUT_SECTIONS.find((s) => s.id === 'features')!
    expect(es.acerca.sections.features).toEqual(section.es)
    expect(en.acerca.sections.features).toEqual(section.en)
  })

  test('`/` renders the six stories (http, no JS), each with a working link', async ({ request }) => {
    const html = await (await request.get('/', { headers: { Accept: 'text/html' } })).text()
    for (const f of SHOP_FEATURES) {
      const card = html.slice(html.indexOf(`data-testid="vende-feature-${f.id}"`))
      expect(card.length, f.id).toBeGreaterThan(0)
      expect(card.slice(0, 4000), f.id).toContain(f.es.title)
      expect(card.slice(0, 4000), f.id).toContain(`href="${f.links[0].href}"`)
    }
  })

  test('/mx/precios lists «Qué incluye tu tienda» and types no peso figure into it (http)', async ({ request }) => {
    const html = await (await request.get('/mx/precios', { headers: { Accept: 'text/html' } })).text()
    const list = block(html, 'precios-includes')
    expect(list).toContain('Qué incluye tu tienda')
    for (const f of SHOP_FEATURES) expect(list, f.id).toContain(f.es.title)
    expect(stripTags(list)).not.toMatch(/\$\s?\d/)
  })
})

// ── S3.1 · ten business-type pages ──────────────────────────────────────────────

test.describe('S3.1 · one page per business type', () => {
  test('there are ten, the eight new ones are written, and every demo shop says «Ejemplo»', () => {
    expect(BUSINESS_TYPE_SLUGS).toHaveLength(10)
    expect(NEW_BUSINESS_TYPE_SLUGS).toHaveLength(8)
    for (const slug of BUSINESS_TYPE_SLUGS) {
      expect(DEMO_SHOPS[slug].name, slug).toMatch(/Ejemplo/)
      expect(DEMO_SHOPS[slug].items.length, slug).toBeGreaterThanOrEqual(3)
    }
    for (const slug of NEW_BUSINESS_TYPE_SLUGS) {
      const page = BUSINESS_TYPE_PAGES[slug]
      expect(page.proofPoints, slug).toHaveLength(4)
      expect(page.metaDescription.length, slug).toBeGreaterThan(60)
    }
  })

  test('the proof slot holds no real shop until one consents, and an empty slot renders NOTHING', () => {
    expect(Object.keys(BUSINESS_PROOF)).toEqual([])
    for (const slug of BUSINESS_TYPE_SLUGS) expect(businessProofFor(slug), slug).toEqual([])

    // The component is a plain function of its props, so call it: an empty list yields `null` — React renders nothing at
    // all for it (no wrapper, no heading, no placeholder). (Playwright's JSX transform cannot render to a string.)
    expect(BusinessProofSlot({ title: 'Negocios como el tuyo', shops: [], pageId: 'x' })).toBeNull()

    // …and the slot is not inert: a consenting shop does render.
    const filled = BusinessProofSlot({
      title: 'Negocios como el tuyo',
      shops: [{ shopName: 'Tienda con permiso', href: '/mx/s/con-permiso' }],
      pageId: 'x',
    })
    expect(filled).not.toBeNull()
  })

  for (const slug of BUSINESS_TYPE_SLUGS) {
    const path = businessTypePath(slug)

    test(`${path} renders without JS with its canonical, OG card, labelled demo shop and support block`, async ({ request }) => {
      const res = await request.get(path, { headers: { Accept: 'text/html' } })
      expect(res.status(), path).toBe(200)
      const html = await res.text()

      // canonical + OG, like the existing verticals
      expect(html).toContain(`<link rel="canonical" href="https://miyagisanchez.com${path}"`)
      expect(html).toContain(`<meta property="og:url" content="https://miyagisanchez.com${path}"`)
      const ogImage = html.match(/<meta property="og:image" content="([^"]+)"/)?.[1]
      expect(ogImage, 'og:image must be present').toBeTruthy()
      expect(new URL(ogImage!).pathname).toContain(`${path}/opengraph-image`)
      // The tag names the production origin; fetch the same route from the server under test.
      const img = await request.get(new URL(ogImage!).pathname)
      expect(img.ok(), `the OG image route must render: ${ogImage}`).toBeTruthy()
      expect(img.headers()['content-type']).toContain('image/')

      // the h1 and the CTA are in the HTML itself (no JS needed)
      expect(html).toMatch(/<h1[^>]*>[^<]+/)
      // …and the page's OWN buttons read «Abrir mi tienda» and open the shop builder (the header carries the same words,
      // so the text alone would prove nothing). `servicios` is the one exception: its button still opens the
      // service-listing wizard (`/sell?type=service`), a destination the shop builder does not replace yet.
      if (slug !== 'servicios') {
        for (const id of [`${slug}-primary-cta`, `${slug}-closing-cta`]) {
          const cta = html.match(new RegExp(`<a[^>]*data-testid="${id}"[^>]*>([\\s\\S]*?)</a>`))
          expect(cta, id).toBeTruthy()
          expect(cta![0], id).toMatch(/href="\/\?[^"]*from=/)
          expect(stripTags(cta![1]).trim(), id).toBe('Abrir mi tienda')
        }
      }

      // demo shop is clearly labelled and carries no price
      const demo = block(html, 'business-demo-shop')
      expect(demo, 'demo shop must render').not.toBe('')
      expect(stripTags(demo)).toContain('Ejemplo')
      // the badge itself says it, not just the invented name («Imprenta Ejemplo»)
      expect(demo).toMatch(/data-testid="business-demo-badge"[^>]*>Ejemplo</)
      expect(stripTags(demo)).toContain('No es un negocio real')
      expect(stripTags(demo)).not.toMatch(/\$\s?\d/)

      // the proof slot is empty ⇒ nothing at all
      expect(html).not.toContain('data-testid="business-proof"')
      expect(html).not.toContain('Negocios como el tuyo ya venden aquí')

      // promoter support block: promoter on their own WhatsApp + the agent; no platform number
      const support = stripTags(block(html, 'seller-support'))
      expect(support).toContain('por su WhatsApp')
      expect(support).toContain('desde la primera visita') // the promoter CARD, not only the lead
      expect(support).toContain(AGENT_LINE)
      expect(support).not.toMatch(/\+52|\d{2}[\s-]?\d{4}[\s-]?\d{4}|horario/i)
    })
  }

  test('an unknown business type is a real 404, not a thin page', async ({ request }) => {
    const res = await request.get('/mx/vende/no-existe-este-negocio', { headers: { Accept: 'text/html' } })
    expect(res.status()).toBe(404)
  })

  test('the platform sitemap lists all ten business-type pages', async ({ request }) => {
    const xml = await (await request.get('/sitemap.xml')).text()
    for (const slug of BUSINESS_TYPE_SLUGS) expect(xml, slug).toContain(`https://miyagisanchez.com${businessTypePath(slug)}</loc>`)
  })

  test('`/` links to every business-type page', async ({ request }) => {
    const html = await (await request.get('/', { headers: { Accept: 'text/html' } })).text()
    for (const slug of BUSINESS_TYPE_SLUGS) expect(html, slug).toContain(`href="${businessTypePath(slug)}"`)
  })
})
