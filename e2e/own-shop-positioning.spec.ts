import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { aboutLlmsTxt, aboutManifestBlock, aboutMcpResource } from '../lib/about-agent'
import { ABOUT_PAGE, ABOUT_SECTIONS, ABOUT_CTA_HREF } from '../lib/about-content'

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

function stripTags(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
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

