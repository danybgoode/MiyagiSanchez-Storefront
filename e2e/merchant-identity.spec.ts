import { test, expect } from '@playwright/test'
import {
  normalizePhoneE164,
  normalizeEmail,
  businessNameKey,
  businessNameSimilarity,
  isFuzzyNameMatch,
  decideDedupeMatch,
  FUZZY_NAME_THRESHOLD,
  type DedupeCandidateRows,
} from '../lib/merchant-identity'

/**
 * Founding merchant activation operations · Sprint 1 (api project, network-free):
 * every branch of `lib/merchant-identity.ts` — the zero-import normalization +
 * dedupe-precedence module the build contract requires a spec to walk directly
 * (sprint-1.md: "so the api spec calls every branch directly").
 */

test.describe('normalizePhoneE164 — Mexican phone → E.164', () => {
  test('a bare 10-digit local number gets the 52 country code', () => {
    expect(normalizePhoneE164('5512345678')).toBe('+525512345678')
  })

  test('punctuation/spaces are stripped before counting digits', () => {
    expect(normalizePhoneE164('55 1234 5678')).toBe('+525512345678')
    expect(normalizePhoneE164('(55) 1234-5678')).toBe('+525512345678')
  })

  test('an already-prefixed 12-digit number passes through with a +', () => {
    expect(normalizePhoneE164('525512345678')).toBe('+525512345678')
  })

  test('too few digits refuses (null), never guesses', () => {
    expect(normalizePhoneE164('12345')).toBeNull()
    expect(normalizePhoneE164('')).toBeNull()
    expect(normalizePhoneE164(null)).toBeNull()
    expect(normalizePhoneE164(undefined)).toBeNull()
  })

  test('an implausibly long digit string refuses rather than truncating', () => {
    expect(normalizePhoneE164('1'.repeat(30))).toBeNull()
  })
})

test.describe('normalizeEmail — exact-match dedupe key', () => {
  test('trims and lower-cases a well-shaped address', () => {
    expect(normalizeEmail('  Lupita@Example.COM ')).toBe('lupita@example.com')
  })

  test('a value with no @ or no dot is refused', () => {
    expect(normalizeEmail('not-an-email')).toBeNull()
    expect(normalizeEmail('missing@dot')).toBeNull()
    expect(normalizeEmail('@missing-local.com')).toBeNull()
  })

  test('blank / absent input refuses', () => {
    expect(normalizeEmail('')).toBeNull()
    expect(normalizeEmail('   ')).toBeNull()
    expect(normalizeEmail(null)).toBeNull()
    expect(normalizeEmail(undefined)).toBeNull()
  })
})

test.describe('businessNameKey — the fuzzy-suggestion comparison key', () => {
  test('strips accents, lower-cases, collapses punctuation/whitespace', () => {
    expect(businessNameKey('Panadería   Lupita!!')).toBe('panaderia lupita')
    expect(businessNameKey('  Café Ñandú  ')).toBe('cafe nandu')
  })

  test('empty / absent input keys to the empty string', () => {
    expect(businessNameKey('')).toBe('')
    expect(businessNameKey(null)).toBe('')
    expect(businessNameKey(undefined)).toBe('')
  })
})

test.describe('businessNameSimilarity / isFuzzyNameMatch — suggest, never merge', () => {
  test('identical names (after normalization) score 1', () => {
    expect(businessNameSimilarity('Panadería Lupita', 'panaderia lupita')).toBe(1)
  })

  test('a one-letter typo scores high enough to flag', () => {
    const sim = businessNameSimilarity('Panaderia Lupita', 'Panaderia Lupitta')
    expect(sim).toBeGreaterThanOrEqual(FUZZY_NAME_THRESHOLD)
    expect(isFuzzyNameMatch('Panaderia Lupita', 'Panaderia Lupitta')).toBe(true)
  })

  test('two unrelated names score low and are never flagged', () => {
    expect(isFuzzyNameMatch('Panadería Lupita', 'Refaccionaria El Tornillo')).toBe(false)
  })

  test('either name empty scores 0, never a false match', () => {
    expect(businessNameSimilarity('', 'Panadería Lupita')).toBe(0)
    expect(isFuzzyNameMatch('', 'Panadería Lupita')).toBe(false)
  })
})

test.describe('decideDedupeMatch — the precedence rule (build contract, sprint-1.md)', () => {
  const none: DedupeCandidateRows = { byShopId: null, byPhone: null, byEmail: null }

  test('whatsapp_e164 alone wins, and ranks after phone and before email (promoter-panel S2)', () => {
    expect(decideDedupeMatch({ ...none, byWhatsapp: { id: 'wa-hit' } })).toEqual({ matched: true, relationshipId: 'wa-hit', matchReason: 'whatsapp_e164' })
    expect(decideDedupeMatch({ ...none, byPhone: { id: 'phone-hit' }, byWhatsapp: { id: 'wa-hit' } }).matched && decideDedupeMatch({ ...none, byPhone: { id: 'phone-hit' }, byWhatsapp: { id: 'wa-hit' } })).toMatchObject({ matchReason: 'phone_e164' })
    expect(decideDedupeMatch({ ...none, byWhatsapp: { id: 'wa-hit' }, byEmail: { id: 'email-hit' } })).toMatchObject({ matchReason: 'whatsapp_e164' })
  })

  test('no candidates → no match', () => {
    expect(decideDedupeMatch(none)).toEqual({ matched: false })
  })

  test('shop_id alone wins', () => {
    const rows: DedupeCandidateRows = { ...none, byShopId: { id: 'shop-hit' } }
    expect(decideDedupeMatch(rows)).toEqual({ matched: true, relationshipId: 'shop-hit', matchReason: 'shop_id' })
  })

  test('phone_e164 alone wins', () => {
    const rows: DedupeCandidateRows = { ...none, byPhone: { id: 'phone-hit' } }
    expect(decideDedupeMatch(rows)).toEqual({ matched: true, relationshipId: 'phone-hit', matchReason: 'phone_e164' })
  })

  test('email_normalized alone wins', () => {
    const rows: DedupeCandidateRows = { ...none, byEmail: { id: 'email-hit' } }
    expect(decideDedupeMatch(rows)).toEqual({ matched: true, relationshipId: 'email-hit', matchReason: 'email_normalized' })
  })

  test('PRECEDENCE: shop_id beats phone AND email when all three hit', () => {
    const rows: DedupeCandidateRows = {
      byShopId: { id: 'shop-hit' },
      byPhone: { id: 'phone-hit' },
      byEmail: { id: 'email-hit' },
    }
    expect(decideDedupeMatch(rows)).toEqual({ matched: true, relationshipId: 'shop-hit', matchReason: 'shop_id' })
  })

  test('PRECEDENCE: phone beats email when both hit and shop_id did not', () => {
    const rows: DedupeCandidateRows = { byShopId: null, byPhone: { id: 'phone-hit' }, byEmail: { id: 'email-hit' } }
    expect(decideDedupeMatch(rows)).toEqual({ matched: true, relationshipId: 'phone-hit', matchReason: 'phone_e164' })
  })
})
