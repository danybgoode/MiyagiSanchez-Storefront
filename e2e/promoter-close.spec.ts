import { test, expect } from '@playwright/test'
import {
  PAID_BY_PROMOTER_FLAG,
  oneTimeGrantNote,
  promoterSourceUrl,
  buildWhatsAppClaimLink,
} from '../lib/promoter-close'

/**
 * Promoter Program · Sprint 4 — the in-person close (api project: pure seams +
 * anonymous/flag-agnostic route guards, no network, no Supabase). Mirrors
 * e2e/promoter-program.spec.ts.
 *
 *  1. PURE LIB — the WhatsApp claim-link builder, the idempotent promoter source
 *     URL, the paid-by-promoter provenance markers (S4 · US-10/US-11).
 *  2. ROUTE GUARDS — the new authed close routes reject when the program is hidden
 *     (404, flag off) OR when anonymous (401, flag on) — asserted in BOTH states so
 *     the gate isn't coupled to the current `promoter.enabled` value (launched ON
 *     2026-06-30; a single flag-coupled status would go red the moment ops toggles).
 *  3. MINI-SITE — /mx/vende/promotor + its sell-sheet render es-MX (US-12).
 *
 * NOT covered (owed to Daniel — sprint-4.md smoke): the live card charge on a
 * seller's behalf (US-10) and the real Clerk claim transfer (US-11).
 */

test.describe('promoter close · paid-by-promoter provenance markers', () => {
  test('PAID_BY_PROMOTER_FLAG is the string "1" (Stripe metadata is string-only)', () => {
    expect(PAID_BY_PROMOTER_FLAG).toBe('1')
  })

  test('oneTimeGrantNote distinguishes promoter-paid from seller-self', () => {
    expect(oneTimeGrantNote(true)).not.toBe(oneTimeGrantNote(false))
    expect(oneTimeGrantNote(true)).toMatch(/promoter/i)
    expect(oneTimeGrantNote(false)).not.toMatch(/promoter/i)
  })
})

test.describe('promoter close · idempotent source URL (promoterSourceUrl)', () => {
  test('deterministic for the same code + shop name, in the promoter:// namespace', () => {
    const a = promoterSourceUrl('PRM-ABC123', 'Café Don Memo')
    const b = promoterSourceUrl('prm-abc123', 'Café Don Memo') // code normalized
    expect(a).toBe(b)
    expect(a.startsWith('promoter://PRM-ABC123/')).toBe(true)
  })

  test('slugifies the shop name (accents/spaces → ascii) and never empty', () => {
    expect(promoterSourceUrl('PRM-XYZ', 'Tienda Ñandú')).toBe('promoter://PRM-XYZ/tienda-nandu')
    expect(promoterSourceUrl('PRM-XYZ', '   ')).toBe('promoter://PRM-XYZ/tienda') // fallback
  })

  test('distinct shop names under one promoter never collide', () => {
    const a = promoterSourceUrl('PRM-ABC123', 'Tienda Uno')
    const b = promoterSourceUrl('PRM-ABC123', 'Tienda Dos')
    expect(a).not.toBe(b)
  })
})

test.describe('promoter close · WhatsApp claim link (buildWhatsAppClaimLink)', () => {
  const claimUrl = 'https://miyagisanchez.com/claim?token=abc.def.ghi'

  test('wraps the claim URL in a wa.me share-sheet link (no phone number)', () => {
    const link = buildWhatsAppClaimLink({ claimUrl, shopName: 'Mi Tienda' })
    expect(link.startsWith('https://wa.me/?text=')).toBe(true)
    // The claim URL survives encode→decode intact.
    const text = decodeURIComponent(link.slice('https://wa.me/?text='.length))
    expect(text).toContain(claimUrl)
    expect(text).toContain('Mi Tienda')
  })

  test('falls back to a generic name when the shop name is blank', () => {
    const link = buildWhatsAppClaimLink({ claimUrl, shopName: '   ' })
    const text = decodeURIComponent(link.slice('https://wa.me/?text='.length))
    expect(text).toContain('tu tienda')
  })

  test('is fully URL-encoded (no raw spaces or newlines leak into the href)', () => {
    const link = buildWhatsAppClaimLink({ claimUrl, shopName: 'Mi Tienda' })
    expect(link).not.toMatch(/\s/)
  })
})

test.describe('promoter close · authed routes respect the kill-switch (flag on OR off)', () => {
  // flag off ⇒ 404 (hidden); flag on ⇒ 401 (auth required). Asserted in both states.
  const authedPosts = [
    '/api/promoter/me/bind',
    '/api/promoter/shop/setup',
    '/api/promoter/claim/link',
    '/api/promoter/close/listing', // Sprint 5 · US-5.1
    '/api/promoter/close/migration', // platform-migrations S2 · US-2.1
  ]
  for (const path of authedPosts) {
    test(`POST ${path} → 404 (hidden) or 401 (live, auth required)`, async ({ request }) => {
      const res = await request.post(path, { data: {} })
      expect([401, 404]).toContain(res.status())
    })
  }

  // The single-product closes are retired: the domain and ML sync are part of Negocio, the subdomain is free, and no
  // printed ads are sold (Daniel, 2026-11-05). Each answers 410 to everyone — never a checkout.
  for (const path of ['/api/promoter/close/domain', '/api/promoter/close/subdomain', '/api/promoter/close/ml-sync', '/api/promoter/close/print']) {
    test(`POST ${path} → 410 (retired)`, async ({ request }) => {
      const res = await request.post(path, { data: {} })
      expect(res.status()).toBe(410)
    })
  }

  // Sprint 5 · US-5.6 — GET, not POST, same guard shape.
  test('GET /api/promoter/rate-card → 410 (the printed-ad rate card is retired)', async ({ request }) => {
    const res = await request.get('/api/promoter/rate-card')
    expect(res.status()).toBe(410)
  })
})

test.describe('promoter close · resources mini-site renders es-MX (US-12)', () => {
  test('GET /mx/vende/promotor → 200 with the three options a promoter sells', async ({ request }) => {
    const res = await request.get('/mx/vende/promotor', { headers: { Accept: 'text/html' } })
    expect(res.status()).toBe(200)
    const html = await res.text()
    // The three options, named after the two plans (Daniel, 2026-11-05), and none of the retired single products.
    expect(html).toContain('Plan Negocio · 1 año')
    expect(html).toContain('Plan Gratis · tienda lista')
    expect(html).not.toContain('Anuncio impreso')
  })

  test('GET /mx/vende/promotor → the trust prompt resolves {url} to its own page (agent-discovery S1.2)', async ({ request }) => {
    const res = await request.get('/mx/vende/promotor', { headers: { Accept: 'text/html' } })
    expect(res.status()).toBe(200)
    const html = await res.text()
    // Regression guard: the promoter mini-site isn't a registered SellerPersonaId, so its
    // trustPrompt used to render the raw, unresolved "{url}" template placeholder.
    expect(html).not.toContain('{url}')
    expect(html).toContain('https://miyagisanchez.com/mx/vende/promotor')
  })

  test('GET /mx/vende/promotor/sell-sheet → 200 printable quick guide, money first', async ({ request }) => {
    const res = await request.get('/mx/vende/promotor/sell-sheet', { headers: { Accept: 'text/html' } })
    expect(res.status()).toBe(200)
    const html = await res.text()
    expect(html).toContain('guardar como PDF') // the .no-print toolbar hint
    expect(html).toContain('data-testid="sell-sheet-packages"')
    // The three options, and nothing retired or printed.
    for (const sku of ['negocio_anual', 'negocio_arranque', 'setup_gratis']) expect(html).toContain(`sell-sheet-package-${sku}`)
    expect(html).not.toContain('Anuncio impreso')
    expect(html).not.toContain('rate-card')
  })
})

/**
 * Founding merchant activation operations · Sprint 1 (Story 1.2/1.3) —
 * `/api/promoter/relationship*` route guards.
 *
 * S1 cross-review round 2 · B9: the FIRST version of this block asserted only
 * a status code drawn from a set that happens to include Next's generic
 * catch-all 404 — the exact "false-positive-spec trap" `Roadmap/LEARNINGS.md`
 * calls out by name (a spec that passes IDENTICALLY against a deliberately
 * broken build). Concretely: before this PR is merged, these routes don't
 * exist on the default `baseURL` (production) at all, so a plain
 * `expect([401,404]).toContain(res.status())` passes today for a reason that
 * has nothing to do with this code — Next's unmatched-route 404 also happens
 * to be status 404. Every assertion below now also requires the ONE thing
 * ONLY a real route can produce: a genuine JSON body (`content-type:
 * application/json`), never Next's `text/html` 404 page — and the two
 * "never leak a 200" cases assert that explicitly rather than the weaker
 * "never 500".
 *
 * Honest status right now: RED against production (the routes are not
 * deployed there yet — this PR is unmerged), and independently confirmed
 * GREEN against a local dev server running this exact code (no secrets
 * required — `isEnabled` fails open to `false` without Supabase configured,
 * so the flag gate itself is real even unconfigured). That is the correct,
 * expected shape for an unmerged PR's route-guard spec: it will flip to
 * green on `origin/main` the moment this merges and deploys, exactly the
 * mechanism `e2e/partner-grants.spec.ts` already proved out for its own
 * (now-merged, now-green) routes.
 *
 * NOT covered here (owed to Daniel — sprint-1.md smoke walkthrough, and the
 * standing gap every promoter/partner api spec in this repo notes): dedupe
 * precedence against REAL rows, partial-save-then-resume, cross-promoter 403
 * against a real second promoter's record, and a real invalid-evidence 422 —
 * all need a live Supabase with the migration applied, a bound promoter Clerk
 * session, and (for the 403 case) a SECOND bound promoter — no fixture for
 * any of that exists in this harness. The PRECEDENCE rule and the EVIDENCE
 * rule themselves are fully covered, network-free, in `e2e/merchant-identity.spec.ts`
 * and `e2e/relationship-consent.spec.ts` — that is deliberately where the real
 * business-logic risk gets exercised, since the route layer is a thin,
 * already-covered-elsewhere composition over them.
 */
test.describe('promoter close · relationship routes respect the kill-switch (flag on OR off)', () => {
  test('POST /api/promoter/relationship (anon) → 404 (hidden) or 401 (live, auth required), genuine JSON', async ({ request }) => {
    const res = await request.post('/api/promoter/relationship', { data: {} })
    expect([401, 404]).toContain(res.status())
    expect(res.headers()['content-type'] ?? '').toContain('application/json')
  })

  test('GET /api/promoter/relationship/[id] (anon, well-formed but nonexistent id) → never 200/500, genuine JSON', async ({ request }) => {
    const res = await request.get('/api/promoter/relationship/00000000-0000-0000-0000-000000000000')
    expect(res.status()).not.toBe(200)
    expect(res.status()).toBeLessThan(500)
    expect([401, 403, 404]).toContain(res.status())
    expect(res.headers()['content-type'] ?? '').toContain('application/json')
  })

  test('GET /api/promoter/relationship/[id] (anon, garbage id) → never 200/500, genuine JSON', async ({ request }) => {
    // A malformed id must fail the SAME way a well-formed-but-absent one does
    // (the shared scope helper fails closed on a read error), not throw —
    // and, before this fix, this test would have accepted a bare 200.
    const res = await request.get('/api/promoter/relationship/not-a-uuid')
    expect(res.status()).not.toBe(200)
    expect(res.status()).toBeLessThan(500)
    expect(res.headers()['content-type'] ?? '').toContain('application/json')
  })

  test('POST /api/promoter/relationship/[id]/consent (anon) → never 200/500, genuine JSON', async ({ request }) => {
    const res = await request.post('/api/promoter/relationship/00000000-0000-0000-0000-000000000000/consent', { data: {} })
    expect(res.status()).not.toBe(200)
    expect(res.status()).toBeLessThan(500)
    expect([401, 403, 404]).toContain(res.status())
    expect(res.headers()['content-type'] ?? '').toContain('application/json')
  })
})

test.describe('promoter close · the public CTA never links to a 404 (promoter-funnel-fixes S1.2)', () => {
  test('GET /promotor/cerrar → redirect (flag on, anon → sign-in) or 404 (flag off)', async ({ request }) => {
    const res = await request.get('/promotor/cerrar', { maxRedirects: 0 })
    expect([301, 302, 303, 307, 308, 404]).toContain(res.status())
  })

  test('anonymous /mx/vende/promotor never links the close-workspace CTA to a 404, and never links it at all (promoter-funnel-v2 US-1.3)', async ({ request }) => {
    // Fire both requests concurrently (not sequentially) so a flag toggle landing
    // between them can't desync the two reads — and both routes read the same 60s
    // in-process cache (lib/flags.ts) regardless, so this is already a vanishingly
    // narrow window (codex cross-review should-fix on PR #157).
    const [page, close] = await Promise.all([
      request.get('/mx/vende/promotor', { headers: { Accept: 'text/html' } }),
      request.get('/promotor/cerrar', { maxRedirects: 0 }),
    ])
    expect(page.status()).toBe(200)
    const html = await page.text()
    const hasCloseCta = html.includes('href="/promotor/cerrar"')
    const closeIs404 = close.status() === 404

    // Safety property (promoter-funnel-fixes S1.2), still holds: whenever the close-workspace
    // CTA IS shown, its target must be reachable — never a dead link. The converse no longer
    // holds since promoter-funnel-v2 US-1.3: the CTA is now bound-promoter-only, so an anonymous
    // visitor never sees it even when the route itself is perfectly reachable (it 30x-redirects
    // them to sign-in). That third state (hidden in favor of the apply teaser, route otherwise
    // reachable) is covered directly against buildPromoterPageConfig in
    // e2e/seller-acquisition-copy.spec.ts ("promoter landing · CTA + wording sweep"); this `api`
    // spec has no way to simulate a bound Clerk session, so it only asserts the anonymous side.
    if (hasCloseCta) {
      expect(closeIs404).toBe(false)
    }

    // This request carries no Clerk session, so the visitor is never a bound promoter — they
    // should always land on the apply-teaser anchor instead of the direct workspace link,
    // regardless of the live promoter.enabled value.
    expect(hasCloseCta).toBe(false)
    expect(html).toContain('href="#promotor-aplica"')
  })
})
