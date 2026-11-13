import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { connectPlanFor, usOnboardingUrl } from '../lib/stripe-connect-market'
import { nudgeCopy } from '../lib/prompt-to-shop/copy-en'

// one-front-door-both-markets D15 + the fresh review on PR #499 — a US shop the builder makes can actually get paid.

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

test('a US seller onboards through the backend Accounts v2 route; a Mexican one keeps Express; unknown is refused', () => {
  expect(connectPlanFor({ market: 'us' })).toEqual({ kind: 'us_v2' })
  expect(connectPlanFor({ market: 'mx' })).toEqual({ kind: 'mx_express' })
  expect(connectPlanFor(null)).toEqual({ kind: 'unknown_market' })
  expect(connectPlanFor({ market: null })).toEqual({ kind: 'unknown_market' })
})

test('the route decides BEFORE it can create a Mexican account, and the v2 call is the backend seller route', () => {
  const src = read('app/api/stripe/connect/route.ts')
  const decide = src.indexOf('connectPlanFor(')
  const createMx = src.indexOf("country: 'MX'")
  expect(decide).toBeGreaterThan(0)
  expect(decide).toBeLessThan(createMx)
  expect(src).toContain('/store/sellers/me/stripe-connect')
  // The account is never named by the caller (us-marketplace D17): no account id or return url from the request.
  const v2 = src.slice(src.indexOf("plan.kind === 'us_v2'"), src.indexOf('return NextResponse.redirect(url)'))
  expect(v2.length).toBeGreaterThan(100)
  expect(v2).not.toMatch(/searchParams|account_id|return_url/)
})

test('only a Stripe-hosted https link is followed', () => {
  expect(usOnboardingUrl({ onboarding_url: 'https://connect.stripe.com/setup/e/acct_1/abc' })).toBe('https://connect.stripe.com/setup/e/acct_1/abc')
  expect(usOnboardingUrl({ onboarding_url: 'https://evil.example/stripe.com' })).toBeNull()
  expect(usOnboardingUrl({ onboarding_url: 'http://connect.stripe.com/x' })).toBeNull()
  expect(usOnboardingUrl({})).toBeNull()
})

test('the kept shop offers a US shop Stripe only, at its /us address, and its payment copy names Stripe', () => {
  const chooser = read('app/(shell)/p2s/_components/CobrosChooser.tsx')
  expect(chooser).toContain("const us = market === 'us'")
  expect(chooser).toContain('data-testid="p2s-choice-stripe"')
  // The Mexican rails sit in the non-US branch: the US branch is everything between `us ? (` and `) : (<>`.
  const usBranch = chooser.slice(chooser.indexOf('{us ? ('), chooser.indexOf(') : (<>'))
  expect(usBranch).not.toMatch(/MP_CONNECT_HREF|speiPatch|cashPatch/)
  expect(chooser).toContain('!us && offersCorreos(')
  const kept = read('app/(shell)/p2s/_components/KeptShop.tsx')
  expect(kept).toContain("marketBasePath(market === 'us' ? 'us' : 'mx')")
  expect(kept).toContain("market === 'us' ? CHECKLIST_COPY.cobrosLeadUs")
  for (const locale of ['es', 'en'] as const) expect(nudgeCopy(locale, 'us').STEP.pagos.lead).toContain('Stripe')
})
