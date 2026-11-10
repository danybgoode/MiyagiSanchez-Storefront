import { expect, test } from '@playwright/test'
import { candidateShopSlugs, isClaimedClaimPage } from './_helpers/claimed-shop-fixture'

/**
 * The pure half of claimed-shop discovery. It replaced trusting the
 * MS_TEST_CLAIMED_SLUG secret after it pointed at a deleted shop and kept the
 * nightly browser smoke red for 3+ weeks.
 */

test.describe('candidateShopSlugs', () => {
  test('unique, sorted, so the pick is reproducible across runs', () => {
    const items = [
      { shop: { slug: 'zeta' } },
      { shop: { slug: 'alfa' } },
      { shop: { slug: 'zeta' } },
    ]
    expect(candidateShopSlugs(items)).toEqual(['alfa', 'zeta'])
    expect(candidateShopSlugs([...items].reverse())).toEqual(['alfa', 'zeta'])
  })

  test('drops items with no shop or an unsafe slug', () => {
    expect(candidateShopSlugs([{}, { shop: null }, { shop: { slug: '../x' } }, { shop: { slug: 'ok-1' } }])).toEqual(['ok-1'])
  })
})

test.describe('isClaimedClaimPage', () => {
  test('claimed = 200 AND the manage CTA rendered', () => {
    expect(isClaimedClaimPage(200, '<a href="/shop/manage" class="btn">')).toBe(true)
  })

  test('an unclaimed shop (claim form, no CTA) is NOT claimed', () => {
    expect(isClaimedClaimPage(200, '<form action="/api/claim">')).toBe(false)
  })

  test('a deleted shop (404 page) is NOT claimed, whatever the body holds', () => {
    // The 404 page embeds the locale dictionary, so a text match on the CTA LABEL
    // would be fooled — the status and the href are what decide.
    expect(isClaimedClaimPage(404, '<a href="/shop/manage">')).toBe(false)
  })
})
