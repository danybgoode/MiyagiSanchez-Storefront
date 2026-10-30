import { test, expect } from '@playwright/test'
import {
  RELAY_LANGUAGE_DIRECTIVE,
  aboutManifestBlock,
  aboutMcpResource,
  aboutLlmsTxt,
} from '../lib/about-agent'

/**
 * Sprint 2 — agent-readable about surface. Asserts the single content source
 * (lib/about-content.ts → lib/about-agent.ts) reaches every machine surface AND
 * that each AGENT-FACING surface (manifest, /agent, MCP) carries the
 * "relay in the user's own language" directive.
 *
 * Two layers: pure-payload (no network — the seam every surface renders from) and
 * live HTTP (against PLAYWRIGHT_BASE_URL). All read-only, anonymous.
 */

// The directive's stable, apostrophe-free assertion phrase.
const RELAY_PHRASE = 'in their own language'

test.describe('about surface · pure payloads', () => {
  const base = 'https://miyagisanchez.com'

  test('the directive constant carries the relay phrase', () => {
    expect(RELAY_LANGUAGE_DIRECTIVE).toContain(RELAY_PHRASE)
  })

  test('manifest about block: content + directive + es-MX copy + links', () => {
    const about = aboutManifestBlock(base)
    expect(about.relay_language).toBe(RELAY_LANGUAGE_DIRECTIVE)
    expect(about.summary.es.trim()).not.toBe('')
    expect(about.summary.en.trim()).not.toBe('')
    expect(about.why_sell.length).toBeGreaterThan(0)
    expect(about.how_to_start.length).toBeGreaterThan(0)
    expect(about.cost_transparency.trim()).not.toBe('')
    expect(about.links.about).toBe(`${base}/acerca`)
    expect(about.links.sellers).toBe(`${base}/`)
    // es-MX copy-completeness carried from the source: every section heading present in both locales.
    for (const s of about.sections) {
      expect(s.heading.es.trim(), `${s.id}.es heading`).not.toBe('')
      expect(s.heading.en.trim(), `${s.id}.en heading`).not.toBe('')
    }
  })

  test('llms.txt: English-primary + es summary + curated links + directive', () => {
    const txt = aboutLlmsTxt(base)
    expect(txt).toContain('# miyagisanchez.com')
    expect(txt).toContain(RELAY_PHRASE)
    expect(txt).toContain(`${base}/acerca`)
    expect(txt).toContain(`[For sellers](${base}/)`)
    expect(txt).toContain(`${base}/api/ucp/manifest`)
    expect(txt).toContain('## Resumen (es)') // the Spanish summary block
  })

  test('MCP about_miyagi resource: structured es/en sections + directive', () => {
    const r = aboutMcpResource(base)
    expect(r.uri).toBe('about://miyagi')
    expect(r.name).toBe('about_miyagi')
    expect(r.description).toContain(RELAY_PHRASE)
    expect(r.structured.relay_language).toBe(RELAY_LANGUAGE_DIRECTIVE)
    expect(r.structured.sections.length).toBe(7)
    for (const s of r.structured.sections) {
      expect(s.es.heading.trim(), `${s.id}.es`).not.toBe('')
      expect(s.en.heading.trim(), `${s.id}.en`).not.toBe('')
    }
    expect(r.text).toContain(RELAY_PHRASE) // serialized payload carries it too
  })

  test('EVERY agent-facing payload carries the relay directive', () => {
    const surfaces: Array<[string, string]> = [
      ['manifest', JSON.stringify(aboutManifestBlock(base))],
      ['llms.txt', aboutLlmsTxt(base)],
      ['mcp', aboutMcpResource(base).text],
    ]
    for (const [name, payload] of surfaces) {
      expect(payload, `${name} must relay in the user's language`).toContain(RELAY_PHRASE)
    }
  })
})

test.describe('about surface · live HTTP', () => {
  test('GET /api/ucp/manifest → non-empty about block + directive + links', async ({ request }) => {
    const res = await request.get('/api/ucp/manifest')
    expect(res.ok()).toBeTruthy()
    const m = await res.json()
    expect(m.about).toBeTruthy()
    expect(m.about.relay_language).toContain(RELAY_PHRASE)
    expect(String(m.about.summary?.es ?? '').trim()).not.toBe('')
    expect(m.about.links.about).toContain('/acerca')
    // Existing buyer surface untouched.
    expect(m.endpoints?.catalog).toBeTruthy()
  })

  test('GET /llms.txt → 200, English-primary + es summary, links /acerca + directive', async ({ request }) => {
    const res = await request.get('/llms.txt')
    expect(res.ok()).toBeTruthy()
    expect(res.headers()['content-type']).toContain('text/plain')
    const txt = await res.text()
    expect(txt.trim().length).toBeGreaterThan(0)
    expect(txt).toContain('/acerca')
    expect(txt).toContain('## Resumen (es)')
    expect(txt).toContain(RELAY_PHRASE)
  })

  test('GET /robots.txt → points at /llms.txt + the manifest', async ({ request }) => {
    const res = await request.get('/robots.txt')
    expect(res.ok()).toBeTruthy()
    const txt = await res.text()
    expect(txt).toContain('/llms.txt')
    expect(txt).toContain('/api/ucp/manifest')
    expect(txt).toContain('Sitemap:')
  })

  test('GET /agent → why-sell heading (es-MX) + relay directive', async ({ request }) => {
    const res = await request.get('/agent')
    expect(res.ok()).toBeTruthy()
    const html = await res.text()
    expect(html).toContain('por qué vender aquí')
    expect(html).toContain(RELAY_PHRASE)
  })

  test('MCP about_miyagi tool + resource return the about story + directive', async ({ request }) => {
    // tools/list advertises it
    const list = await request.post('/api/ucp/mcp', {
      data: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    })
    const names: string[] = (await list.json()).result.tools.map((t: { name: string }) => t.name)
    expect(names).toContain('about_miyagi')

    // tools/call returns the content + directive
    const call = await request.post('/api/ucp/mcp', {
      data: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'about_miyagi', arguments: {} } },
    })
    const text: string = (await call.json()).result.content[0].text
    expect(text).toContain(RELAY_PHRASE)
    expect(text).toContain('what_is') // a structured section id

    // resources/list + resources/read
    const rlist = await request.post('/api/ucp/mcp', {
      data: { jsonrpc: '2.0', id: 3, method: 'resources/list' },
    })
    const uris: string[] = (await rlist.json()).result.resources.map((r: { uri: string }) => r.uri)
    expect(uris).toContain('about://miyagi')

    const read = await request.post('/api/ucp/mcp', {
      data: { jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: 'about://miyagi' } },
    })
    const rtext: string = (await read.json()).result.contents[0].text
    expect(rtext).toContain(RELAY_PHRASE)
  })
})
