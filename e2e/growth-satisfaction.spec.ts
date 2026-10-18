import { expect, test } from '@playwright/test'
import { decideSatisfaction, satisfactionAnswered, withSatisfactionAnswered } from '../lib/growth-track'

/**
 * golden-frijoles satisfied-ask — the setup guide's "¿Te ayudó…?" answer. The pure decision `app/api/growth/
 * satisfaction/route.ts` composes, then the route's anonymous arm (the `api` project runs without a Clerk session).
 */
const USER = 'user_test123'

test.describe('growth satisfaction · decideSatisfaction', () => {
  test('a 1–5 score or "dismissed" for the setup guide forwards, with the flag on', () => {
    for (const answer of [1, 2, 3, 4, 5, 'dismissed'] as const) {
      expect(decideSatisfaction(true, { userId: USER, featureId: 'setup_guide', answer })).toEqual({
        forward: true,
        userId: USER,
        featureId: 'setup_guide',
        answer,
      })
    }
  })

  test('flag off → not forwarded, but only after the body is valid', () => {
    expect(decideSatisfaction(false, { userId: USER, featureId: 'setup_guide', answer: 4 })).toEqual({
      forward: false,
      reason: 'flag_off',
    })
    expect(decideSatisfaction(false, { userId: USER, featureId: 'setup_guide', answer: 9 })).toEqual({
      forward: false,
      reason: 'invalid_answer',
    })
  })

  test('a feature that is not allow-listed is refused', () => {
    for (const featureId of ['checkout.stripe_enabled', '', undefined, 'SETUP_GUIDE']) {
      expect(decideSatisfaction(true, { userId: USER, featureId, answer: 5 })).toEqual({
        forward: false,
        reason: 'unknown_feature',
      })
    }
  })

  test('anything a button could not send is refused', () => {
    for (const answer of [0, 6, 4.5, '4', null, undefined, 'ahora no']) {
      expect(decideSatisfaction(true, { userId: USER, featureId: 'setup_guide', answer })).toEqual({
        forward: false,
        reason: 'invalid_answer',
      })
    }
  })
})

test.describe('growth satisfaction · asked once (the shop row the route claims)', () => {
  test('answered = the key is present (the claim\'s IS NULL rule); absent or null is "not yet"', () => {
    for (const value of [true, false, 'true', 1])
      expect(satisfactionAnswered({ settings: { guide: { satisfaction_answered: value } } })).toBe(true)
    for (const meta of [null, undefined, {}, { settings: {} }, { settings: { guide: {} } },
      { settings: { guide: { satisfaction_answered: null } } }])
      expect(satisfactionAnswered(meta)).toBe(false)
  })

  test('the claim sets the flag and keeps every other key', () => {
    const before = { stripe: { on: true }, settings: { hero: { title: 'x' }, guide: { guide_dismissed: false, share_done: true } } }
    expect(withSatisfactionAnswered(before)).toEqual({
      stripe: { on: true },
      settings: { hero: { title: 'x' }, guide: { guide_dismissed: false, share_done: true, satisfaction_answered: true } },
    })
    expect(withSatisfactionAnswered(null)).toEqual({ settings: { guide: { satisfaction_answered: true } } })
    expect(satisfactionAnswered(withSatisfactionAnswered(before))).toBe(true)
  })
})

test.describe('growth satisfaction API · anonymous is rejected', () => {
  test('POST /api/growth/satisfaction with a well-formed body → 401 (no Clerk session)', async ({ request }) => {
    const res = await request.post('/api/growth/satisfaction', { data: { featureId: 'setup_guide', answer: 5 } })
    expect(res.status()).toBe(401)
  })
})
