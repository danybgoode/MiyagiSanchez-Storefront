import { test, expect } from '@playwright/test'

/**
 * Navigation & Settings Reorg — Sprint 4 (entry-point wiring · api gate).
 *
 * 4.1 — the signed-out seller pitch and the publish action are distinct surfaces:
 *   - signed-out CTAs ("Publicar gratis" header, "Vende gratis" footer) → / (the shop builder)
 *     (epic #6's acquisition landing).
 *   - the publish affordance (bottom-bar ⊕ FAB, signed-in "Publicar") stays /sell.
 * 4.2 — Vecindario left the tab bar in S1, so the Inicio feed carries an entry to it,
 *   and the footer Vecindario link still resolves to /vecindario.
 *
 * Anonymous request → the home page renders the signed-out chrome (Clerk `<Show
 * when="signed-out">`) and the catalog-independent Vecindario card. No mutation.
 */
test.describe('nav entry points · the seller landing vs /sell + Vecindario', () => {
  test('signed-out seller CTAs lead to the shop builder at /, not /sell', async ({ request }) => {
    const res = await request.get('/mx', { headers: { Accept: 'text/html' } })
    expect(res.ok()).toBeTruthy()
    const html = await res.text()

    // The two named signed-out pitch CTAs render and sit inside an anchor to the root, the
    // seller landing since root-shop-builder-home.
    expect(html).toMatch(/href="\/"[^>]*>\s*Publicar gratis/)
    expect(html).toMatch(/href="\/"[^>]*>\s*Vende gratis/)

    // Regression guard: neither pitch CTA is wired to the publish flow any more.
    expect(html).not.toMatch(/href="\/sell"[^>]*>\s*Publicar gratis/)
    expect(html).not.toMatch(/href="\/sell"[^>]*>\s*Vende gratis/)
  })

  test('the publish affordance (⊕ FAB) still resolves to /sell', async ({ request }) => {
    const res = await request.get('/mx', { headers: { Accept: 'text/html' } })
    expect(res.ok()).toBeTruthy()
    const html = await res.text()
    // The bottom-bar FAB is always rendered and points at the publish flow.
    expect(html).toContain('href="/sell"')
  })

  test('the Inicio feed carries a Vecindario entry that resolves to /vecindario', async ({ request }) => {
    // `/` is now the market selector; the Inicio feed lives at the Mexico
    // marketplace homepage.
    const res = await request.get('/mx', { headers: { Accept: 'text/html' } })
    expect(res.ok()).toBeTruthy()
    const html = await res.text()
    // Stable marker on the feed card (set in app/page.tsx), wired to /vecindario.
    // Attribute order isn't guaranteed, so match both within the same <a> tag.
    expect(html).toContain('data-testid="vecindario-feed-entry"')
    expect(html).toMatch(
      /<a[^>]*data-testid="vecindario-feed-entry"[^>]*href="\/vecindario"[^>]*>|<a[^>]*href="\/vecindario"[^>]*data-testid="vecindario-feed-entry"[^>]*>/,
    )
  })

  test('the footer Vecindario link still resolves to /vecindario', async ({ request }) => {
    const res = await request.get('/mx', { headers: { Accept: 'text/html' } })
    expect(res.ok()).toBeTruthy()
    const html = await res.text()
    expect(html).toContain('href="/vecindario"')
  })
})
