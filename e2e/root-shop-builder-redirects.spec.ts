import { test, expect } from '@playwright/test'

/**
 * root-shop-builder-home D6 — the old seller-landing addresses land on the root in ONE hop,
 * with their campaign tags, and only the bare landing moved.
 *
 * HTTP, not a source read: the rules live in `next.config.ts` `redirects()`, which runs ahead
 * of the middleware, and the only honest proof that a printed flyer still works is the response
 * a phone actually gets. `maxRedirects: 0` so a two-hop chain (`/vende` → `/mx/vende` → `/`)
 * fails here instead of being followed to a green 200.
 */

async function hop(request: import('@playwright/test').APIRequestContext, path: string) {
  const res = await request.get(path, { maxRedirects: 0 })
  const location = res.headers()['location'] ?? ''
  // Next may answer with an absolute or a relative Location; compare path + query only.
  const target = location ? new URL(location, 'https://placeholder.invalid') : null
  return { status: res.status(), path: target?.pathname ?? null, search: target?.searchParams ?? null }
}

test.describe('the old seller landing addresses go to the shop builder at /', () => {
  test('/mx/vende → / in one 308, keeping UTM, the A/B variant and from', async ({ request }) => {
    const r = await hop(request, '/mx/vende?utm_source=flyer&utm_campaign=oct&v=b&from=promo')
    expect(r.status).toBe(308)
    expect(r.path).toBe('/')
    expect(r.search?.get('utm_source')).toBe('flyer')
    expect(r.search?.get('utm_campaign')).toBe('oct')
    expect(r.search?.get('v')).toBe('b')
    expect(r.search?.get('from')).toBe('promo')
  })

  test('/vende → / directly, never through /mx/vende', async ({ request }) => {
    const r = await hop(request, '/vende?utm_source=qr')
    expect(r.status).toBe(308)
    expect(r.path).toBe('/')
    expect(r.search?.get('utm_source')).toBe('qr')
  })

  test('/mercado → /mx, the marketplace alias', async ({ request }) => {
    const r = await hop(request, '/mercado')
    expect(r.status).toBe(308)
    expect(r.path).toBe('/mx')
  })

  test('only the bare landing moved: persona and sub-paths resolve as before', async ({ request }) => {
    // The negation of the move — a rule that swallowed `/mx/vende/*` would strand every
    // persona campaign and the fundadoras form POST.
    expect((await request.get('/mx/vende/creadores', { maxRedirects: 0 })).status()).toBe(200)
    const legacyPersona = await hop(request, '/vende/creadores?utm_source=x')
    expect(legacyPersona.status).toBe(308)
    expect(legacyPersona.path).toBe('/mx/vende/creadores')
    expect(legacyPersona.search?.get('utm_source')).toBe('x')
  })

  test('the root itself answers 200 with the describe box, no hop', async ({ request }) => {
    const res = await request.get('/', { maxRedirects: 0 })
    expect(res.status()).toBe(200)
    expect(await res.text()).toContain('data-testid="p2s-describe-box"')
  })
})
