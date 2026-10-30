import { test, expect } from '@playwright/test'

/**
 * Agent-readability & marketing-surface guard (epic 07,
 * agent-readability-marketing-surface, Story 1.3).
 *
 * Fetches the campaign chain WITHOUT JS (plain `request` fixture, same idiom
 * as `e2e/agent-discovery.spec.ts`) and asserts every link an AI agent or a
 * chat-app link-preview bot follows returns substantive content — not just a
 * 200 — plus the OG/canonical metadata Story 1.2 fixed.
 *
 * Observed-red evidence (2026-07-16): run against PRODUCTION (the default
 * `baseURL`, pre-fix at the time this spec was authored) — the /agent and
 * /terminos canonical/og:url assertions failed for real:
 *   - GET https://miyagisanchez.com/agent      → no `<link rel="canonical">`,
 *     `og:url` = "https://miyagisanchez.com" (root, not self)
 *   - GET https://miyagisanchez.com/terminos   → same: no canonical, og:url
 *     points at root
 *   - GET https://miyagisanchez.com/acerca     → no `og:image` meta at all
 * All three go green once Story 1.2's fix (this same branch) is live. The
 * `/acerca` non-empty-body assertions were already green pre-fix (Story 1.1's
 * premise didn't reproduce live on 2026-07-16 — see the PR body) — the
 * bogus-path variant below is the observed-red mechanism for that guard.
 */

const OG_IMAGE_PAGES = ['/', '/mx', '/us', '/acerca', '/agent']

function ogTag(html: string, property: string): string | null {
  const re = new RegExp(`<meta property="${property}" content="([^"]*)"`)
  const match = html.match(re)
  return match ? match[1] : null
}

function canonicalHref(html: string): string | null {
  const match = html.match(/<link rel="canonical" href="([^"]*)"/)
  return match ? match[1] : null
}

test.describe('Agent-readability surface — substantive content', () => {
  test('/ returns the substantive master-brand market selector', async ({ request }) => {
    const res = await request.get('/')
    expect(res.ok()).toBeTruthy()
    const html = await res.text()
    expect(html.length).toBeGreaterThan(10_000)
    expect(html).toContain('Tu tienda es tuya. El mercado es por país.')
    // Literals on purpose, not locale lookups: this asserts what a link-preview bot
    // actually READS off the page. Keyed against `locales/es.json` it would only prove
    // the page and the spec agree, and would stay green through any copy change.
    // Updated by the one-landing-per-market brand sweep — the markets are markets OF
    // Miyagi Sánchez, so "Entrar a Miyagi México" became "Entrar al mercado de México".
    expect(html).toContain('Entrar al mercado de México')
    expect(html).toContain('Entrar al mercado de Estados Unidos')
  })

  test('/mx returns the Mexico marketplace shell, not an empty page', async ({ request }) => {
    const res = await request.get('/mx')
    expect(res.ok()).toBeTruthy()
    const html = await res.text()
    expect(html.length).toBeGreaterThan(20_000)
    expect(html).toContain('Miyagi Sánchez')
    expect(html).toContain('¿Qué estás buscando?')
  })

  test('/ returns the seller-acquisition pitch (root-shop-builder-home)', async ({ request }) => {
    const res = await request.get('/')
    expect(res.ok()).toBeTruthy()
    const html = await res.text()
    expect(html.length).toBeGreaterThan(20_000)
    expect(html).toContain('0% de comisión')
  })

  test('bare /acerca returns full HTML to a plain no-JS fetch (Story 1.1 regression guard)', async ({ request }) => {
    const res = await request.get('/acerca')
    expect(res.ok()).toBeTruthy()
    const html = await res.text()
    // Real about-copy markers — the founder section is the deepest, most
    // specific proof this isn't an empty/shell response.
    expect(html.length).toBeGreaterThan(20_000)
    expect(html).toContain('Quién está detrás')
    expect(html).toContain('Daniel Vásquez')
    expect(html).toContain('¿Qué es miyagisanchez.com y por qué vender aquí?')

    // JSON-LD Organization block, real + parseable (grounded description, not stubbed).
    const match = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)
    expect(match).toBeTruthy()
    const jsonLd = JSON.parse(match![1])
    expect(jsonLd['@type']).toBe('Organization')
    expect(typeof jsonLd.description).toBe('string')
    expect(jsonLd.description.length).toBeGreaterThan(20)
  })

  test('a bogus path does NOT return substantive content — proves the /acerca assertion above is a real, falsifiable check', async ({ request }) => {
    // Observed-red mechanism (red-green rule) for the /acerca non-empty-body
    // guard: since bare /acerca is already green pre-fix (Story 1.1's premise
    // didn't reproduce live — see PR body), point the same assertion at a
    // path that genuinely 404s, so this file demonstrably CAN fail red.
    const res = await request.get('/acerca-does-not-exist-guard-check')
    expect(res.ok()).toBeFalsy()  // a real not-found, not a thin 200 shell
    const html = await res.text()
    expect(html).not.toContain('Quién está detrás')
  })

  test('/agent returns the machine-readable agent briefing', async ({ request }) => {
    const res = await request.get('/agent')
    expect(res.ok()).toBeTruthy()
    const html = await res.text()
    expect(html.length).toBeGreaterThan(10_000)
    expect(html).toContain('/api/ucp/mcp')
    const match = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)
    expect(match).toBeTruthy()
    const jsonLd = JSON.parse(match![1])
    expect(jsonLd['@type']).toBe('WebAPI')
  })

  test('/llms.txt mentions the key agent-discovery pages', async ({ request }) => {
    const res = await request.get('/llms.txt')
    expect(res.ok()).toBeTruthy()
    const body = await res.text()
    // llms.txt is host-aware (built from the request's own Host header — see
    // app/llms.txt/route.ts), so assert on the path only, not a hardcoded
    // domain — this must hold against prod AND a local/preview build alike.
    expect(body).toContain('/acerca')
    // The seller landing is the root since root-shop-builder-home.
    expect(body).toMatch(/\[For sellers\]\(https?:\/\/[^)\s]+\/\)/)
    expect(body).toContain('/agent')
    expect(body).toContain('/api/ucp/manifest')
  })

  test('/robots.txt points agents at llms.txt + the capability manifest', async ({ request }) => {
    const res = await request.get('/robots.txt')
    expect(res.ok()).toBeTruthy()
    const body = await res.text()
    expect(body).toContain('llms.txt')
    expect(body).toContain('/api/ucp/manifest')
  })

  test('/api/ucp/manifest parses as JSON and advertises the MCP endpoint', async ({ request }) => {
    const res = await request.get('/api/ucp/manifest')
    expect(res.ok()).toBeTruthy()
    const manifest = await res.json()
    expect(manifest.name).toBe('miyagisanchez-ucp')
    expect(manifest.endpoints.mcp.url).toContain('/api/ucp/mcp')
    expect(Array.isArray(manifest.endpoints.mcp.mcp_tools)).toBe(true)
    expect(manifest.endpoints.mcp.mcp_tools.length).toBeGreaterThan(0)
  })
})

test.describe('Agent-readability surface — OG/social-preview sweep (Story 1.2)', () => {
  for (const path of OG_IMAGE_PAGES) {
    test(`${path} has an og:image`, async ({ request }) => {
      const res = await request.get(path)
      expect(res.ok()).toBeTruthy()
      const html = await res.text()
      const ogImage = ogTag(html, 'og:image')
      expect(ogImage).toBeTruthy()
    })
  }

  test('/mx and the seller landing at / share the same visual OG frame (shared template) with distinct headlines', async ({ request }) => {
    const [home, vende] = await Promise.all([request.get('/mx'), request.get('/')])
    const homeAlt = ogTag(await home.text(), 'og:image:alt')
    const vendeAlt = ogTag(await vende.text(), 'og:image:alt')
    expect(homeAlt).toBeTruthy()
    expect(vendeAlt).toBeTruthy()
    expect(homeAlt).not.toBe(vendeAlt)
  })

  // Canonical/og:url are deliberately PRODUCTION-absolute on every host —
  // that's how canonicals work (a preview page's canonical must point at the
  // prod URL, never at the preview), so these assertions hardcode the prod
  // origin on purpose and hold against prod, preview, and local alike
  // (confirmed by this PR's own CI run vs the Vercel preview).
  test('/agent has a self-referential canonical + og:url (was missing / pointed at "/")', async ({ request }) => {
    const res = await request.get('/agent')
    const html = await res.text()
    expect(canonicalHref(html)).toBe('https://miyagisanchez.com/agent')
    expect(ogTag(html, 'og:url')).toBe('https://miyagisanchez.com/agent')
  })

  test('/terminos has a self-referential canonical + og:url (was pointing at "/")', async ({ request }) => {
    const res = await request.get('/terminos')
    const html = await res.text()
    expect(canonicalHref(html)).toBe('https://miyagisanchez.com/terminos')
    expect(ogTag(html, 'og:url')).toBe('https://miyagisanchez.com/terminos')
  })

  test('/acerca has its own og:image (was missing entirely)', async ({ request }) => {
    const res = await request.get('/acerca')
    const html = await res.text()
    const ogImage = ogTag(html, 'og:image')
    expect(ogImage).toBeTruthy()
    // Its own image, not the site-wide root default.
    expect(ogImage).toContain('/acerca/opengraph-image')
  })
})
