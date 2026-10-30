import { readFileSync } from 'fs'
import { join } from 'path'
import { expect, test } from '@playwright/test'
import { resolveSellerSignupMarket } from '../lib/seller-signup-market'
import { sellerLandingPath } from '../lib/seller-acquisition'
import { sellerListingCurrency } from '../lib/seller-listing-currency'

/**
 * us-marketplace S5.2 (D17) — the signup handoff carries the intended market into the
 * FIRST seller create.
 *
 * Shop creation carried no market at all, so a merchant who signed up from `/us` got a
 * Mexican shop — pricing in pesos, publishing into the Mexican marketplace — and
 * nothing anywhere told them. The market is immutable after creation (D7), so that
 * first request is the only moment it can be set, and getting it wrong meant a shop
 * that had to be recreated.
 */

const root = process.cwd()
const source = (rel: string) => readFileSync(join(root, ...rel.split('/')), 'utf8')

test.describe('resolveSellerSignupMarket', () => {
  test('accepts an open market', () => {
    expect(resolveSellerSignupMarket('us')).toBe('us')
    expect(resolveSellerSignupMarket('mx')).toBe('mx')
    expect(resolveSellerSignupMarket('US')).toBe('us')
    expect(resolveSellerSignupMarket('  us  ')).toBe('us')
  })

  test('returns undefined — never `mx` — for anything it does not recognise', () => {
    // `undefined` and `'mx'` are DIFFERENT answers. Substituting one for the other
    // would make this a second, competing source of the MX default, and a paraphrased
    // contract drifts permissive (LEARNINGS). Omitting the field lets the backend
    // apply the one documented default.
    for (const bad of ['ca', 'usa', 'united states', '', '   ', null, undefined, 42, {}, ['us']]) {
      expect(resolveSellerSignupMarket(bad), JSON.stringify(bad)).toBeUndefined()
    }
  })

  test('reads the registry, so a market that closes stops accepting shops without a code change', () => {
    // The guard is `marketplace_status === 'active'`, not a hardcoded list of open
    // markets. Asserted on the SOURCE because both markets are active today, so no
    // input can exercise the closed branch — and a branch no test can reach is
    // exactly the one that rots.
    const fn = source('lib/seller-signup-market.ts')
    expect(fn).toMatch(/marketplace_status === 'active'/)
    expect(fn).not.toMatch(/\breturn 'mx'\b/)
  })
})

test.describe('the market reaches the create', () => {
  test('a US first listing uses persisted USD for product, Stripe and mirrors', () => {
    const market = resolveSellerSignupMarket('us')
    expect(sellerListingCurrency({ operating_market: market })).toBe('USD')
    expect(sellerListingCurrency({ operating_market: 'mx' })).toBe('MXN')
    expect(sellerListingCurrency({})).toBe('MXN') // legacy seller only
    expect(sellerListingCurrency({ operating_market: 'unknown' })).toBeNull()

    const wizard = source('app/(shell)/sell/SellWizard.tsx')
    const route = source('app/api/sell/create/route.ts')
    expect(wizard).toMatch(/market: signupMarket/)
    expect(wizard).toMatch(/currency: listingCurrency/)
    expect(route).toMatch(/const intendedCurrency = sellerListingCurrency\(operatingMarket/)
    expect(route).toMatch(/sellerListingCurrency\(sellerForMirror\?\.metadata\)/)
    expect(route.match(/currency: listingCurrency(?:\.toLowerCase\(\))?/g)?.length).toBeGreaterThanOrEqual(5)
    expect(route).not.toMatch(/currency: body\.listing\.currency/)
  })

  test('ensureShop sends operating_market, and only when it has one', () => {
    const ensure = source('lib/ensure-shop.ts')
    expect(ensure).toMatch(/operating_market: body\.operatingMarket/)
    // Conditional: an absent market must send NO key, so the backend applies its
    // own default rather than receiving an empty string to interpret.
    expect(ensure).toMatch(/\.\.\.\(body\.operatingMarket \? \{ operating_market/)
  })

  test('a market conflict is reported as itself, not flattened into a 500', () => {
    // The backend answers 409 for "this shop already operates elsewhere" and 422 for
    // an invalid market. Both are permanent decisions. Reporting them as "could not
    // create the shop, try again" would send a merchant into an endless retry.
    const ensure = source('lib/ensure-shop.ts')
    expect(ensure).toMatch(/createRes\.status === 409 \|\| createRes\.status === 422/)
  })

  test('the API route narrows the body rather than passing it through', () => {
    const route = source('app/api/sell/shop/route.ts')
    expect(route).toMatch(/operatingMarket: resolveSellerSignupMarket\(body\.market\)/)
    // The raw body value must never be handed to ensureShop as the market.
    expect(route).not.toMatch(/operatingMarket: body\.market\b/)
  })

  test('the server page narrows the query string before the client sees it', () => {
    const page = source('app/(shell)/sell/page.tsx')
    expect(page).toMatch(/resolveSellerSignupMarket\(marketParam\)/)
    expect(page).toMatch(/signupMarket=\{signupMarket\}/)
  })
})

test.describe('the US has a seller entry at all', () => {
  test('the market home offers signup on both markets, carrying the US market', () => {
    const home = source('app/(mx-site)/mx/page.tsx')
    expect(home).toMatch(/\/sell\?market=us/)
    // The old shape: the CTA existed only for MX, so a US visitor had no way in.
    expect(home).not.toMatch(/market === 'mx' && <AuthShow/)
  })

  test('a US visitor is not sent to the Spanish pitch page', () => {
    // The property, stated against the function that decides it rather than against
    // the shape of one call site. `/mx/vende` is the es-MX recruitment page; sending a
    // US merchant there is a language mismatch at the very first step of onboarding.
    //
    // This used to pin the literal ternary `market === 'mx' ? … : …` in the market
    // home's source. That passed for exactly as long as the destinations lived in that
    // one expression — and the same bug it was written to catch was live the whole time
    // in `PlatformShell`, whose header, mobile and footer CTAs were a hardcoded
    // `/vende` in BOTH markets. A source-shape assertion guards a spelling; this guards
    // the rule, and every call site now reads it from here.
    expect(sellerLandingPath('mx')).toBe('/')
    expect(sellerLandingPath('us')).toBe('/us/sell')
    expect(sellerLandingPath('us')).not.toBe(sellerLandingPath('mx'))
  })

  test('every signed-out sell CTA in the shared chrome is market-derived, not a literal', () => {
    const shell = source('app/components/PlatformShell.tsx')
    // Three affordances render a signed-out sell CTA — mobile header, desktop header,
    // footer. All three read the same resolved landing.
    expect(shell.match(/href=\{sellerLanding\}/g) ?? []).toHaveLength(3)
    expect(shell).not.toMatch(/href="\/vende"/)

    const home = source('app/(mx-site)/mx/page.tsx')
    expect(home).toMatch(/href=\{sellerLandingPath\(market\)\}/)
  })
})
