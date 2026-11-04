import { test, expect } from '@playwright/test'
import { resolveClaimedShop } from './_helpers/claimed-shop-fixture'

/**
 * Own-shop premium presentation · Sprint 2, Story 2.2 — collection-page
 * isolation. Mirrors own-shop-channel.spec.ts's pattern: the channel path
 * (`/c/[collection]`) resolves its shop ONLY from the `x-miyagi-shop-slug`
 * request header, which middleware.ts sets and STRIPS any client-supplied
 * value for on platform hosts — so a spoofed header can never leak a shop's
 * collection page onto the platform host from here. The genuine cross-host
 * (real subdomain/custom-domain) case can't be exercised against a platform
 * preview/prod baseURL at all (previews can't be reached by a foreign Host)
 * — that's local `curl -H "Host: …"` pre-merge + Daniel's real-domain smoke
 * post-merge, per this sprint's own QA plan.
 *
 * Fixture-gated tests use a claimed shop DISCOVERED from the live catalog
 * (MS_TEST_CLAIMED_SLUG is only a checked, optional pin). Both assert a 404,
 * so a DEAD shop slug passed them vacuously — the pinned `miyagiprints` had
 * been deleted and these stayed green while proving nothing.
 */

test.describe('collection page — platform-host isolation (always on)', () => {
  test('/c/[collection] with no channel header (platform host) → 404', async ({ request }) => {
    const res = await request.get('/c/some-collection')
    expect(res.status()).toBe(404)
  })

  test('a spoofed x-miyagi-shop-slug on the platform host does NOT leak a channel collection page', async ({ request }) => {
    // Mirrors own-shop-channel.spec.ts: middleware strips inbound x-miyagi-*
    // trust headers on platform hosts, so this must 404 exactly like the
    // header-less case above, never render as if genuinely on-channel.
    const res = await request.get('/c/some-collection', {
      headers: {
        'x-miyagi-channel': 'custom',
        'x-miyagi-domain': 'attacker.example',
        'x-miyagi-shop-slug': 'panuchas',
      },
    })
    expect(res.status()).toBe(404)
  })
})

test.describe('collection page — marketplace-path isolation (fixture-gated)', () => {
  let CLAIMED_SLUG: string | null = null
  let reason = ''
  test.beforeAll(async ({ request }) => {
    const fixture = await resolveClaimedShop(request, process.env.MS_TEST_CLAIMED_SLUG)
    CLAIMED_SLUG = fixture.slug
    reason = fixture.reason ?? ''
  })

  test('a nonexistent collection under a real shop → 404, not a crash', async ({ request }) => {
    test.skip(!CLAIMED_SLUG, `FIXTURE UNAVAILABLE — ${reason}`)
    const res = await request.get(`/s/${CLAIMED_SLUG}/c/definitely-not-a-real-collection-xyz`)
    expect(res.status()).toBe(404)
  })

  test('a malformed collection slug 404s before any Medusa fetch', async ({ request }) => {
    test.skip(!CLAIMED_SLUG, `FIXTURE UNAVAILABLE — ${reason}`)
    const res = await request.get(`/s/${CLAIMED_SLUG}/c/${encodeURIComponent('../etc/passwd')}`)
    expect(res.status()).toBe(404)
  })
})
